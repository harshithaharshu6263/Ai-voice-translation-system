"""Optional real-service check using synthetic audio and a temporary account.

Run explicitly: python smoke_services.py. Requires an internet connection.
No emails are sent and no data is added to the application's account database.
"""
import base64
import io
import tempfile
from pathlib import Path
from workspace import create_app


def main():
    with tempfile.TemporaryDirectory() as temp:
        app = create_app({'TESTING': True, 'DATABASE': str(Path(temp) / 'smoke.sqlite3')})
        client = app.test_client()
        client.get('/register')
        with client.session_transaction() as session:
            token = session['csrf']
        client.post('/register', data={'name': 'Service test', 'email': 'test@example.com',
            'password': 'temporary-test-password', 'csrf_token': token})
        client.get('/dashboard')
        with client.session_transaction() as session:
            headers = {'X-CSRF-Token': session['csrf']}
        response = client.post('/tts-generate', json={'text': 'Hello. How are you today?', 'lang': 'en'}, headers=headers)
        assert response.status_code == 200, response.json
        audio = base64.b64decode(response.json['audio_base64'])
        print('Online audio generated:', len(audio), 'bytes')
        response = client.post('/api/transcribe', data={'audio': (io.BytesIO(audio), 'synthetic.mp3'),
                               'language': 'en-IN'}, headers=headers)
        assert response.status_code == 200, response.json
        print('Audio upload and online transcription passed.')
        response = client.post('/translate', json={'text': response.json['text'], 'source': 'auto', 'target': 'kn'}, headers=headers)
        assert response.status_code == 200, response.json
        assert response.json['translated']
        print('Online translation and detected source:', response.json['detected'])
        assert len(client.get('/api/history').json['items']) == 1
        print('Temporary history saved. Real-service checks passed.')


if __name__ == '__main__':
    main()
