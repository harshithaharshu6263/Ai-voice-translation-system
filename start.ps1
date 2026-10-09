$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:PORT = '8500'
if (Test-Path -LiteralPath '.venv\Scripts\python.exe') {
    & '.venv\Scripts\python.exe' -c 'import flask_mail, langdetect, speech_recognition, docx, dotenv, imageio_ffmpeg' 2>$null
    if ($LASTEXITCODE -eq 0) {
        & '.venv\Scripts\python.exe' app.py
        exit $LASTEXITCODE
    }
}
if (Test-Path -LiteralPath '.dependencies') {
    $env:PYTHONPATH = Join-Path $PSScriptRoot '.dependencies'
}
python app.py
