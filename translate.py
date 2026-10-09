from flask import Blueprint, request, jsonify
from deep_translator import GoogleTranslator

translate_bp = Blueprint("translate", __name__)

@translate_bp.route("/translate", methods=["POST"])
def translate_text():
    data = request.get_json()
    text = data.get("text", "")
    target = data.get("target", "kn")

    try:
        translated = GoogleTranslator(source="auto", target=target).translate(text)
        return jsonify({"translated": translated})
    except Exception as e:
        return jsonify({"translated": "Translation failed"})
