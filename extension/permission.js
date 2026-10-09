const msg = document.getElementById('msg');
navigator.mediaDevices.getUserMedia({ audio: true }).then(
  (s) => { s.getTracks().forEach((t) => t.stop()); msg.textContent = 'Microphone allowed. You can close this tab and press Alt+Shift+N on any page.'; },
  (e) => { msg.textContent = `Microphone blocked (${e.name}). Allow it for this extension in Chrome settings, then reload this page.`; },
);
