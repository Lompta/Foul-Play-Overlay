@echo off
rem Chrome launches this when the Foul Play Overlay extension needs the server.
"%~dp0..\.venv\Scripts\python.exe" "%~dp0native_host.py" %*
