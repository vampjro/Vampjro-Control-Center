@echo off
title VAMPJRO Remote Control Center
cd /d "%~dp0.."
node --max-old-space-size=128 src/server/index.js
