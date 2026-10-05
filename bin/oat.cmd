@ECHO OFF
REM Standalone launcher: run OAT from the repo without `npm link`.
REM Requires a build first (npm run build).
node "%~dp0..\dist\cli.js" %*
