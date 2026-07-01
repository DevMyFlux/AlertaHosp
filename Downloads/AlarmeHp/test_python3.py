import requests
import json
import base64

API_KEY = "38340e5d"
API_SECRET = "ILKpz5neRhVusWnW"
FROM_NUMBER = "556298792013"
LATINO_WHATSAPP = "551186510453"

auth_string = f"{API_KEY}:{API_SECRET}"
auth_bytes = auth_string.encode('utf-8')
auth_b64 = base64.b64encode(auth_bytes).decode('utf-8')

payload = {
    "from": FROM_NUMBER,
    "to": LATINO_WHATSAPP,
    "message_type": "text",
    "text": "TESTE PYTHON",
    "channel": "whatsapp"
}

headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": f"Basic {auth_b64}"
}

res = requests.post("https://api.nexmo.com/v1/messages", json=payload, headers=headers)
print(res.status_code)
print(res.json())

