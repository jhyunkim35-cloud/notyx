const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const firebaseAuthSource = fs.readFileSync('public/js/firebase_auth.js', 'utf8');
const demoSource = fs.readFileSync('public/js/demo.js', 'utf8');

class ElementStub {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.disabled = false;
    this.innerHTML = '';
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }
}

function createScenario(loginResult) {
  const elements = {
    quizInlineArea: new ElementStub('div'),
    classifyArea: new ElementStub('div'),
    splitAsk: new ElementStub('div'),
    splitViewer: new ElementStub('div'),
    quizBtn: new ElementStub('button'),
    classifyBtn: new ElementStub('button'),
  };
  elements.splitViewer.style.display = 'block';

  const document = {
    body: { style: { overflow: 'hidden' } },
    createElement: tagName => new ElementStub(tagName),
    getElementById: id => elements[id] || null,
    addEventListener: () => {},
  };
  const authenticatedUser = { uid: 'auth-user-1' };
  const context = {
    console,
    document,
    window: { nyDemoActive: true },
    firebase: {
      auth: { GoogleAuthProvider: class GoogleAuthProvider {} },
    },
    auth: { signInWithPopup: async () => ({ user: loginResult }) },
    Sentry: undefined,
    showToast: () => {},
    currentUser: authenticatedUser,
    storedNotesText: 'demo notes',
    storedFilteredText: 'demo source',
    storedPptText: 'demo slides',
    extractedImages: [{ slideNumber: 1, imageBase64: 'demo-image' }],
  };

  vm.runInNewContext(demoSource, context, { filename: 'demo.js' });
  context.loginWithGoogle = async () => loginResult;
  context.window.nyDemoActive = true;

  return { context, elements, authenticatedUser };
}

async function assertLoginWithGoogleReturnsAuthContract() {
  const authenticatedUser = { uid: 'auth-user-1' };
  const successContext = {
    console,
    firebase: {
      auth: { GoogleAuthProvider: class GoogleAuthProvider {} },
    },
    auth: { signInWithPopup: async () => ({ user: authenticatedUser }) },
    Sentry: undefined,
    showToast: () => {},
  };
  vm.runInNewContext(firebaseAuthSource, successContext, { filename: 'firebase_auth.js' });
  assert.strictEqual(
    await successContext.loginWithGoogle(),
    authenticatedUser,
    'successful popup auth returns the Firebase user',
  );

  const cancelledContext = {
    ...successContext,
    auth: { signInWithPopup: async () => { throw { code: 'auth/popup-closed-by-user' }; } },
  };
  vm.runInNewContext(firebaseAuthSource, cancelledContext, { filename: 'firebase_auth.js' });
  assert.equal(await cancelledContext.loginWithGoogle(), null, 'cancelled popup auth returns null');
}

async function assertSuccessfulLoginClosesDemo() {
  const authenticatedUser = { uid: 'auth-user-1' };
  const scenario = createScenario(authenticatedUser);
  const { context, elements } = scenario;

  context.renderDemoLoginCta('quiz');
  const button = elements.quizInlineArea.children[0].children[2];
  await button.onclick();

  assert.equal(context.window.nyDemoActive, false, 'successful CTA login closes the demo');
  assert.equal(elements.splitViewer.style.display, 'none', 'successful CTA login hides the viewer');
  assert.equal(context.document.body.style.overflow, '', 'successful CTA login restores body scrolling');
  assert.equal(context.storedNotesText, '', 'successful CTA login clears injected note data');
  assert.equal(context.storedFilteredText, '', 'successful CTA login clears injected source data');
  assert.equal(context.storedPptText, '', 'successful CTA login clears injected slide text');
  assert.equal(context.extractedImages.length, 0, 'successful CTA login clears injected images');
  assert.equal(elements.quizBtn.disabled, true, 'successful CTA login disables the demo quiz button');
  assert.equal(elements.classifyBtn.disabled, true, 'successful CTA login disables the demo classify button');
}

async function assertCancelledLoginKeepsDemo() {
  const scenario = createScenario(null);
  const { context, elements } = scenario;
  const injectedImages = context.extractedImages;

  context.renderDemoLoginCta('quiz');
  const button = elements.quizInlineArea.children[0].children[2];
  await button.onclick();

  assert.equal(context.window.nyDemoActive, true, 'cancelled CTA login keeps the demo active');
  assert.equal(elements.splitViewer.style.display, 'block', 'cancelled CTA login keeps the viewer open');
  assert.equal(context.document.body.style.overflow, 'hidden', 'cancelled CTA login keeps body scrolling locked');
  assert.equal(context.storedNotesText, 'demo notes', 'cancelled CTA login keeps injected note data');
  assert.equal(context.storedFilteredText, 'demo source', 'cancelled CTA login keeps injected source data');
  assert.equal(context.storedPptText, 'demo slides', 'cancelled CTA login keeps injected slide text');
  assert.strictEqual(context.extractedImages, injectedImages, 'cancelled CTA login keeps injected images intact');
}

(async () => {
  await assertSuccessfulLoginClosesDemo();
  await assertCancelledLoginKeepsDemo();
  await assertLoginWithGoogleReturnsAuthContract();
  console.log('demo auth transition: 3 checks passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
