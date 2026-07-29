async function testSignup() {
  try {
    const res = await fetch('http://localhost:8080/api/auth/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: 'test' + Date.now() + '@example.com',
        password: 'password123',
        full_name: 'Test User',
        role: 'employee'
      })
    });
    const data = await res.json();
    console.log("Status:", res.status);
    console.log("Response:", data);
  } catch (err) {
    console.error("Error:", err);
  }
}

testSignup();
