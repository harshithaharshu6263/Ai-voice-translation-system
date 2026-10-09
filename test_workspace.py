"""Run with python -m unittest -v test_workspace (services are mocked)."""
import base64
from contextlib import closing
import io
import re
import sqlite3
import tempfile
import unittest
import wave
import requests
from pathlib import Path
from unittest.mock import patch

from docx import Document
import speech_recognition as sr
from workspace import create_app, translate_online


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app({'TESTING': True, 'DATABASE': str(Path(self.temp.name) / 'test.sqlite3'),
                               'SECRET_KEY': 'test-only', 'MAIL_USERNAME': '', 'MAIL_PASSWORD': ''})
        self.client = self.app.test_client()
        self.register(self.client, 'alice@example.com')

    def tearDown(self):
        self.temp.cleanup()

    def token(self, client):
        with client.session_transaction() as session:
            return session['csrf']

    def register(self, client, email):
        page = client.get('/register')
        self.assertEqual(page.status_code, 200)
        response = client.post('/register', data={'name': 'Alice', 'email': email, 'password': 'good-password',
                                                  'csrf_token': self.token(client)})
        self.assertEqual(response.status_code, 302)
        client.get('/dashboard')

    def request(self, path, data=None, method='POST', client=None):
        client = client or self.client
        return client.open(path, method=method, json=data, headers={'X-CSRF-Token': self.token(client)})

    def translation(self, client=None, **changes):
        with patch('workspace.translate_online', return_value=('ನಮಸ್ಕಾರ ಪ್ರಪಂಚ', 'en')):
            response = self.request('/translate', {'text': 'Hello world', 'source': 'auto', 'target': 'kn', **changes}, client=client)
        self.assertEqual(response.status_code, 200)
        return response.json

    def test_registration_hashes_password(self):
        with closing(sqlite3.connect(self.app.config['DATABASE'])) as connection:
            password = connection.execute('SELECT password_hash FROM users').fetchone()[0]
        self.assertNotEqual(password, 'good-password')
        self.assertTrue(password.startswith('scrypt:'))

    def test_login_and_logout(self):
        response = self.request('/logout')
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.client.get('/api/history').status_code, 401)
        self.client.get('/')
        response = self.client.post('/', data={'email': 'alice@example.com', 'password': 'good-password',
                                               'csrf_token': self.token(self.client)})
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.client.get('/dashboard').status_code, 200)

    def test_duplicate_registration_and_short_password(self):
        client = self.app.test_client()
        client.get('/register')
        data = {'name': 'Other', 'email': 'alice@example.com', 'password': 'good-password', 'csrf_token': self.token(client)}
        self.assertIn(b'already registered', client.post('/register', data=data).data)
        data.update(email='new@example.com', password='short')
        self.assertIn('8–128', client.post('/register', data=data).get_data(as_text=True))

    def test_csrf_rejects_mutation(self):
        self.assertEqual(self.client.post('/translate', json={'text': 'hello'}).status_code, 403)
        self.assertEqual(self.client.delete('/api/history/1').status_code, 403)

    def test_translation_detection_and_history(self):
        record = self.translation(text='This is a sentence written in English for the language detector.')
        self.assertEqual(record['detected'], 'en')
        self.assertEqual(record['target'], 'kn')
        self.assertEqual(self.client.get('/api/history').json['items'][0]['id'], record['id'])

    def test_translation_validation(self):
        for data in ({'text': ''}, {'text': 'x' * 5001}, {'text': 'hello', 'target': 'bad'},
                     {'text': 'hello', 'source': []}, {'text': ['invalid']}):
            self.assertEqual(self.request('/translate', data).status_code, 400)

    def test_service_failure_does_not_save_history(self):
        with patch('workspace.translate_online', side_effect=RuntimeError('private upstream details')):
            response = self.request('/translate', {'text': 'hello', 'target': 'kn'})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('private upstream details', response.get_data(as_text=True))
        self.assertEqual(self.client.get('/api/history').json['items'], [])

    def test_provider_response_and_timeout(self):
        with patch('workspace.requests.get') as get:
            get.return_value.json.return_value = [[['ನಮಸ್ಕಾರ', 'Hello'], [' ಲೋಕ', ' world']], None, 'en']
            self.assertEqual(translate_online('Hello world', 'auto', 'kn'), ('ನಮಸ್ಕಾರ ಲೋಕ', 'en'))
            self.assertEqual(get.call_args.kwargs['timeout'], (5, 20))
        with patch('workspace.translate_online', side_effect=requests.Timeout):
            self.assertEqual(self.request('/translate', {'text': 'hello', 'target': 'kn'}).status_code, 504)

    def test_account_isolation(self):
        record = self.translation()
        other = self.app.test_client()
        self.register(other, 'bob@example.com')
        self.assertEqual(other.get('/api/history').json['items'], [])
        self.assertEqual(other.get(f'/api/export/{record["id"]}/docx').status_code, 404)
        self.assertEqual(self.request(f'/api/history/{record["id"]}', {'favorite': True}, 'PATCH', other).status_code, 404)
        self.assertEqual(self.request(f'/api/history/{record["id"]}', method='DELETE', client=other).status_code, 404)

    def test_favorites_search_and_delete(self):
        record = self.translation(text='A memorable phrase')
        self.assertEqual(self.request(f'/api/history/{record["id"]}', {'favorite': True}, 'PATCH').status_code, 200)
        result = self.client.get('/api/history?favorites=1&q=memorable').json['items']
        self.assertEqual(len(result), 1)
        self.assertEqual(self.client.get('/api/history?q=doesnotexist').json['items'], [])
        self.assertEqual(self.request(f'/api/history/{record["id"]}', method='DELETE').status_code, 200)
        self.assertEqual(self.client.get('/api/history?favorites=1').json['items'], [])

    def test_history_pagination(self):
        with closing(sqlite3.connect(self.app.config['DATABASE'])) as connection:
            user = connection.execute('SELECT id FROM users').fetchone()[0]
            connection.executemany('INSERT INTO translations(user_id,original,translated,source,target) VALUES (?,?,?,?,?)',
                                   [(user, f'item {i}', 'translated', 'en', 'kn') for i in range(53)])
            connection.commit()
        first = self.client.get('/api/history').json
        self.assertTrue(first['has_more'])
        self.assertEqual(len(first['items']), 50)
        second = self.client.get(f'/api/history?before={first["items"][-1]["id"]}').json
        self.assertEqual(len(second['items']), 3)
        self.assertFalse(second['has_more'])
        self.assertEqual(self.client.get('/api/history?before=bad').status_code, 400)

    def test_conversation_turn_is_saved(self):
        record = self.translation(source='en', mode='conversation', speaker='A')
        self.assertEqual((record['mode'], record['speaker']), ('conversation', 'A'))

    def test_exports_preserve_unicode(self):
        record = self.translation()
        text = self.client.get(f'/api/export/{record["id"]}/txt')
        self.assertIn('ನಮಸ್ಕಾರ ಪ್ರಪಂಚ', text.data.decode('utf-8-sig'))
        word = self.client.get(f'/api/export/{record["id"]}/docx')
        self.assertEqual(word.status_code, 200)
        document = Document(io.BytesIO(word.data))
        self.assertIn('ನಮಸ್ಕಾರ ಪ್ರಪಂಚ', '\n'.join(p.text for p in document.paragraphs))
        self.assertIn('attachment', word.headers['Content-Disposition'])

    def test_profile_and_password_change(self):
        bad = self.request('/api/profile', {'name': 'Updated', 'current_password': 'wrong', 'new_password': 'another-password'}, 'PATCH')
        self.assertEqual(bad.status_code, 400)
        response = self.request('/api/profile', {'name': 'Updated', 'current_password': 'good-password', 'new_password': 'another-password'}, 'PATCH')
        self.assertEqual(response.json['name'], 'Updated')
        self.assertNotIn('password_hash', response.json)

    def test_audio_generation_language_and_bytes(self):
        response = self.request('/tts-generate', {'text': 'hello', 'lang': 'invalid'})
        self.assertEqual(response.status_code, 400)
        with patch('gtts.gTTS.write_to_fp', side_effect=lambda buffer: buffer.write(b'fake-mp3')):
            response = self.request('/tts-generate', {'text': 'hello', 'lang': 'en'})
        self.assertEqual(base64.b64decode(response.json['audio_base64']), b'fake-mp3')

    def test_email_configuration_and_delivery(self):
        record = self.translation()
        self.assertEqual(self.request('/api/email', {'id': record['id'], 'email': 'friend@example.com'}).status_code, 503)
        self.app.config.update(MAIL_USERNAME='sender@example.com', MAIL_PASSWORD='test-only')
        with patch('flask_mail.Mail.send') as send:
            response = self.request('/api/email', {'id': record['id'], 'email': 'friend@example.com', 'attachment': 'docx'})
        self.assertEqual(response.status_code, 200)
        message = send.call_args.args[0]
        self.assertIn(record['translated'], message.body)
        self.assertEqual(message.attachments[0].filename, 'translation.docx')
        self.assertEqual(self.request('/api/email', {'id': record['id'], 'email': 'invalid'}).status_code, 400)

    def test_upload_validation(self):
        headers = {'X-CSRF-Token': self.token(self.client)}
        self.assertEqual(self.client.post('/api/transcribe', data={}, headers=headers).status_code, 400)
        response = self.client.post('/api/transcribe', data={'audio': (io.BytesIO(b'x'), 'file.exe')}, headers=headers)
        self.assertEqual(response.status_code, 400)
        response = self.client.post('/api/transcribe', data={'audio': (io.BytesIO(b'x'), 'file.wav'), 'language': '../oops'}, headers=headers)
        self.assertEqual(response.status_code, 400)

    def test_email_pdf_and_recording_attachments(self):
        record = self.translation()
        self.app.config.update(MAIL_USERNAME='sender@example.com', MAIL_PASSWORD='test-only')
        for kind, filename, content, mime in [('pdf', 'saved.pdf', b'%PDF-1.7\nsynthetic fixture', 'application/pdf'),
                                              ('recording', 'voice.wav', b'RIFF synthetic fixture', 'audio/wav')]:
            with patch('flask_mail.Mail.send') as send:
                response = self.client.post('/api/email', data={'id': str(record['id']), 'email': 'friend@example.com',
                    'attachment': kind, 'attachment_file': (io.BytesIO(content), filename)},
                    headers={'X-CSRF-Token': self.token(self.client)})
            self.assertEqual(response.status_code, 200, response.json)
            self.assertEqual(send.call_args.args[0].attachments[0].content_type, mime)
        response = self.client.post('/api/email', data={'id': str(record['id']), 'email': 'friend@example.com',
            'attachment': 'pdf', 'attachment_file': (io.BytesIO(b'not pdf'), 'bad.pdf')},
            headers={'X-CSRF-Token': self.token(self.client)})
        self.assertEqual(response.status_code, 400)
    def test_real_audio_conversion_with_mocked_recognition(self):
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
            wav.writeframes(b'\x00\x00' * 16000)
        buffer.seek(0)
        with patch('speech_recognition.Recognizer.recognize_google', return_value='Recognized speech'):
            response = self.client.post('/api/transcribe', data={'audio': (buffer, 'speech.wav'), 'language': 'en-IN'},
                                        headers={'X-CSRF-Token': self.token(self.client)})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['text'], 'Recognized speech')
        self.assertAlmostEqual(response.json['duration'], 1)

    def test_empty_audio_and_corrupt_upload(self):
        headers = {'X-CSRF-Token': self.token(self.client)}
        response = self.client.post('/api/transcribe', data={'audio': (io.BytesIO(b'not audio'), 'bad.mp3')}, headers=headers)
        self.assertEqual(response.status_code, 400)


if __name__ == '__main__':
    unittest.main()
