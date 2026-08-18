document.documentElement.lang = chrome.i18n.getUILanguage()
document.title = chrome.i18n.getMessage('extName')
document.getElementById('ext-name')!.textContent = chrome.i18n.getMessage('extName')
document.getElementById('grant-body')!.textContent = chrome.i18n.getMessage('grantBody')

const grantButton = document.getElementById('grant') as HTMLButtonElement
const statusEl = document.getElementById('status')!
grantButton.textContent = chrome.i18n.getMessage('grantAllow')

grantButton.addEventListener('click', () => {
  void ask()
})

void ask()

async function ask(): Promise<void> {
  statusEl.textContent = chrome.i18n.getMessage('statusRequesting')
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((track) => track.stop())
    await chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_GRANTED' })
    window.close()
  } catch {
    await chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_DENIED' }).catch(() => undefined)
    statusEl.textContent = chrome.i18n.getMessage('micDenied')
    statusEl.classList.add('error')
  }
}
