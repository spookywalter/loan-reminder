const express = require('express');
const path = require('path');
const app = express();

const frontendPath = path.join(__dirname, '.dist', 'frontend html');

app.use(express.static(frontendPath));

// Serve index.html for root requests
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Fallback for any other route
app.use((req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.listen(5500, () => {
  console.log('Frontend served on http://localhost:5500');
  console.log('Open http://localhost:5500 in your browser');
});
