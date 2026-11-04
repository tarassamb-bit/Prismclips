(() => {
  'use strict';

  const pageName = (pathname) => pathname.split('/').pop() || 'index.html';
  const legacyPages = {
    '#signin': 'login.html',
    '#account': 'login.html',
    '#download': 'download.html',
    '#macos': 'download.html#macos',
    '#windows': 'download.html#windows',
    '#linux': 'download.html#linux',
    '#workspace': 'features.html#workspace',
    '#how-it-works': 'how-it-works.html',
    '#faq': 'faq.html'
  };
  if (pageName(location.pathname) === 'index.html' && legacyPages[location.hash]) {
    const destination = new URL(legacyPages[location.hash], location.href);
    destination.search = location.search;
    location.replace(destination.href);
    return;
  }

  document.querySelectorAll('#main-nav a, .header-actions a').forEach((link) => {
    const destination = new URL(link.href, location.href);
    // Vercel cleanUrls serves /pricing for pricing.html, so compare paths without the extension.
    const page = (path) => path.replace(/\/$/, '/index').replace(/\.html$/, '');
    const current = destination.origin === location.origin && page(destination.pathname) === page(location.pathname);
    if (current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  // The pages are written for visitors: "Sign in" and "Try it free" (sign-up). Signed in (Supabase keeps the session in
  // localStorage), the header shows only "Open Prism" and the main buttons go straight into the app, which re-checks the session.
  try {
    const session = JSON.parse(localStorage.getItem('sb-isdplhahgggundbohmlr-auth-token') || 'null');
    if (session?.user?.id) {
      document.querySelectorAll('.nav-signin').forEach((link) => { link.hidden = true; });
      document.querySelectorAll('.nav-download, [data-cta]').forEach((link) => {
        link.href = '/app/';
        link.firstChild.textContent = 'Open Prism ';
      });
    }
  } catch {}

  const menu = document.querySelector('.menu-toggle');
  const nav = document.getElementById('main-nav');
  const mobileNavigation = window.matchMedia('(max-width: 900px)');
  if (menu && nav) {
    const menuIsOpen = () => menu.getAttribute('aria-expanded') === 'true';
    function closeMenu(restoreFocus = false) {
      const wasOpen = menuIsOpen();
      menu.setAttribute('aria-expanded', 'false');
      menu.setAttribute('aria-label', 'Open navigation');
      nav.classList.remove('is-open');
      if (wasOpen && restoreFocus) menu.focus();
    }
    menu.addEventListener('click', () => {
      if (menuIsOpen()) {
        closeMenu(true);
        return;
      }
      if (!mobileNavigation.matches) return;
      menu.setAttribute('aria-expanded', 'true');
      menu.setAttribute('aria-label', 'Close navigation');
      nav.classList.add('is-open');
      nav.querySelector('a[href], button:not([disabled])')?.focus();
    });
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a[href]')) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menuIsOpen()) {
        event.preventDefault();
        closeMenu(true);
      }
    });
    document.addEventListener('click', (event) => {
      if (!nav.contains(event.target) && !menu.contains(event.target)) closeMenu();
    });
    document.addEventListener('focusin', (event) => {
      if (menuIsOpen() && !nav.contains(event.target) && !menu.contains(event.target)) closeMenu();
    });
    mobileNavigation.addEventListener('change', (event) => {
      const focusWillBeHidden = event.matches && nav.contains(document.activeElement);
      closeMenu();
      if (focusWillBeHidden) menu.focus();
    });
    closeMenu();
  }

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const destination = new URL(link.href, location.href);
    if (!destination.hash || destination.origin !== location.origin
      || destination.pathname !== location.pathname || destination.search !== location.search) return;
    let id;
    try { id = decodeURIComponent(destination.hash.slice(1)); } catch { return; }
    const target = document.getElementById(id);
    if (!target) return;
    const addedTabindex = !target.hasAttribute('tabindex');
    if (addedTabindex) {
      target.setAttribute('tabindex', '-1');
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
    }
    target.focus({ preventScroll: true });
  });

  const features = {
    moments: {
      kicker: 'THE STORY COMES FIRST',
      title: ['More than a clip.', 'A complete thought.'],
      description: 'Prism looks for a hook, the context, and a payoff. Cuts land on whole sentences, so your best ideas get the room they need.',
      points: ['Moments from across your selected range', 'Review and refine every suggested Short'],
      image: 'assets/create.webp', width: 1200, height: 750,
      alt: "Prism's create screen with controls for number of Shorts, clip length, source range, and caption style.",
      caption: 'Your footage. Your brief. Your call.'
    },
    framing: {
      kicker: 'A NEW PERSPECTIVE',
      title: ['The right frame.', 'For every story.'],
      description: 'Give a widescreen story a vertical point of view. Follow the subject with Fill, keep the full picture with Fit, or stack two views with Split.',
      points: ['AI subject framing with a smoothed camera path', 'Fine-tune the crop yourself in the editor'],
      image: 'assets/layouts.webp', width: 1600, height: 999,
      alt: 'Prism layout examples showing Fill with a tracked crop, Fit with a blurred background, and Split with two stacked speakers.',
      caption: 'Fill. Fit. Split. Find your angle.'
    },
    captions: {
      kicker: 'GIVE YOUR WORDS SOME PRESENCE',
      title: ['Sound off.', 'Story still on.'],
      description: 'Make your words part of the picture. Choose from seven caption styles, then adjust the size and position to match your voice.',
      points: ['Word highlighting when verified timing is available', 'Caption styles you can change before export'],
      image: 'assets/captions.webp', width: 1600, height: 846,
      alt: 'Seven Prism caption styles including Simple, Viral highlight, Highlight box, Bold caps, Minimal, One word, and Podcast treatments.',
      caption: 'Different styles. Still your voice.'
    }
  };
  const tabs = Array.from(document.querySelectorAll('[data-feature]'));
  function selectFeature(tab) {
    const feature = features[tab.dataset.feature];
    if (!feature) return;
    tabs.forEach((item) => {
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    });
    document.getElementById('feature-panel').setAttribute('aria-labelledby', tab.id);
    document.getElementById('feature-kicker').textContent = feature.kicker;
    const title = document.getElementById('feature-title');
    title.replaceChildren(document.createTextNode(feature.title[0]), document.createElement('br'), document.createTextNode(feature.title[1]));
    document.getElementById('feature-description').textContent = feature.description;
    const points = document.getElementById('feature-points');
    points.querySelectorAll('li').forEach((item, index) => {
      item.lastChild.textContent = ' ' + feature.points[index];
    });
    const image = document.getElementById('feature-image');
    image.alt = feature.alt;
    image.width = feature.width;
    image.height = feature.height;
    image.src = feature.image;
    document.getElementById('feature-caption').textContent = feature.caption;
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectFeature(tab));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectFeature(tabs[next]);
      tabs[next].focus();
    });
  });
})();
