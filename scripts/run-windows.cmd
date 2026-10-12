@echo off
rem Starts Playlite from this folder — used by the "Playlite" scheduled task (see README → Run it all the time).
rem Output goes to data\playlite.log.
cd /d "%~dp0.."
if not exist data mkdir data
node src\index.js >> data\playlite.log 2>&1
