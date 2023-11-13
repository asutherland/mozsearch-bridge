function bookmarkletFromCode(str) {
  // IIFE construct, str needs to contain a function
  return 'javascript:' + str + ';void(0);';
}

async function makeBookmarklet() {
  const resp = await fetch('inject-minimal.bundle.js');
  const text = await resp.text();
  const linkText = bookmarkletFromCode(text);

  const elem = document.getElementById('magic-bookmarklet');
  elem.href = linkText;
  elem.textContent = `PBridge: ${document.location.host}`;
}

makeBookmarklet();