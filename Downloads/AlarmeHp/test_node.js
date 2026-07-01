const fetch = require('node-fetch');
const apiKey = '38340e5d';
const apiSecret = 'ILKpz5neRhVusWnW';
const authString = `${apiKey}:${apiSecret}`;
const authB64 = Buffer.from(authString).toString('base64');
const to = '551186510453';
const from = '556298792013';

fetch('https://api.nexmo.com/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Basic ${authB64}`
  },
  body: JSON.stringify({
    from: from,
    to: to,
    message_type: 'text',
    text: `TEST`,
    channel: 'whatsapp'
  })
}).then(r => r.json()).then(console.log);
