#!/bin/bash

if [ "$1" == "live" ]
then
    ssh -i "/c/Users/lenovo/Desktop/credientals/imageoptimizer.pem" ubuntu@16.148.168.34 "
    cd image-optimizer-backend/
    git stash
    git pull origin main
    npm install
    pm2 restart backend
    "
else
    echo "Only 'live' target is configured. Run: ./upload.sh live"
fi