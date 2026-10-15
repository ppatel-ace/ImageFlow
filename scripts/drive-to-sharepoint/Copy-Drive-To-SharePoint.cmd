@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Copy-Drive-To-SharePoint.ps1" %*
echo.
pause