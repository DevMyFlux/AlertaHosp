import requests
import json
import base64

API_KEY = "38340e5d"
API_SECRET = "ILKpz5neRhVusWnW"
FROM_NUMBER = "556298792013"
NUMEROS_WHATSAPP = [{"numero": "551186510453", "nome": "Latino"}, {"numero": "5511943004579", "nome": "Novo"}]

auth_string = f"{API_KEY}:{API_SECRET}"
auth_bytes = auth_string.encode('utf-8')
auth_b64 = base64.b64encode(auth_bytes).decode('utf-8')

headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": f"Basic {auth_b64}"
}

for info in NUMEROS_WHATSAPP:
    payload = {
        "from": FROM_NUMBER,
        "to": info["numero"],
        "message_type": "text",
        "text": "🔐 TESTE",
        "channel": "whatsapp"
    }
    res = requests.post("https://api.nexmo.com/v1/messages", json=payload, headers=headers)
    print(res.status_code, res.json())
