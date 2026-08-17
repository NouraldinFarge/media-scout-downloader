const status = document.querySelector('#fixtureStatus');

for (const button of document.querySelectorAll('[data-fetch]')) {
  button.addEventListener('click', () => runFetch(button.dataset.fetch));
}

document.querySelector('#corsButton').addEventListener('click', () => {
  const crossOriginUrl = `http://127.0.0.1:${location.port}/cors/media.mp4`;
  return runFetch(crossOriginUrl);
});

document.querySelector('#blobButton').addEventListener('click', async () => {
  try {
    const response = await fetch('generated/scout-demo.mp4');
    const mediaBlob = await response.blob();
    const video = document.createElement('video');
    video.controls = true;
    video.dataset.fixture = 'page-local-blob';
    video.src = URL.createObjectURL(mediaBlob);
    document.querySelector('.media-grid').append(video);
    status.textContent = 'Created a page-local Blob URL from the controlled MP4 fixture.';
  } catch (error) {
    status.textContent = `Blob fixture failed as expected: ${error.message}`;
  }
});

document.querySelector('#pathologicalButton').addEventListener('click', () => {
  const container = document.createElement('div');
  container.id = 'pathologicalFixture';
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 20000; index += 1) {
    const item = document.createElement(index % 20 === 0 ? 'a' : 'span');
    item.textContent = `Synthetic element ${index + 1}`;
    if (item instanceof HTMLAnchorElement) item.href = `generated/scout-demo.mp4?fixture=${index}`;
    fragment.append(item);
  }
  container.append(fragment);
  document.body.append(container);
  status.textContent = 'Created exactly 20,000 controlled DOM elements.';
});

async function runFetch(url) {
  status.textContent = `Requesting ${displayPath(url)}…`;
  try {
    const response = await fetch(url);
    await response.arrayBuffer();
    status.textContent = `${displayPath(url)} returned HTTP ${response.status}.`;
  } catch (error) {
    status.textContent = `${displayPath(url)} was blocked or failed: ${error.message}`;
  }
}

function displayPath(rawUrl) {
  try {
    return new URL(rawUrl, location.href).pathname;
  } catch (_error) {
    return 'controlled fixture';
  }
}
