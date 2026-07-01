import fetch from 'node-fetch';

async function test() {
  const response = await fetch('http://localhost:3000/api/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sector: 'Test Sector',
      message: 'Test Message',
      phone: '5511943004579'
    })
  });
  console.log(response.status);
  const data = await response.json();
  console.log(data);
}
test();
