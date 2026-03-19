@echo off
set "DIR=%~dp0.."
"%DIR%\node_modules\.bin\tsx.cmd" "%DIR%\src\cli.ts" %*
