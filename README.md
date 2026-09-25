services:
    - type: web
    name: e-martcom-secure
    env: node
    plan: free
    buildCommand: npm install
    startCommand: node server.js
    envVars:
            - key: MPESA_CONSUMER_KEY
        sync: false
            - key: MPESA_CONSUMER_SECRET
        sync: false
            - key: MPESA_PASSKEY
        sync: false
            - key: MPESA_SHORTCODE
        value: 174379
            - key: MPESA_ENVIRONMENT
        value: sandbox
            - key: CALLBACK_URL
        value: https://e-martcom.onrender.com/api/callback/mpesa
