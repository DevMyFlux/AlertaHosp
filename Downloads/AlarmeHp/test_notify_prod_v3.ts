import fetch from 'node-fetch';

async function run() {
  const response = await fetch('http://localhost:3000/api/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sector: 'TEST',
      message: 'TEST MSG FROM JWT AUTH',
      phone: '551186510453',
    })
  });
  console.log("Status:", response.status);
  const data = await response.json();
  console.log("Data:", data);
}
run();
