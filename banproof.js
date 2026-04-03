  const revealElements = document.querySelectorAll('.reveal');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry, i) => {
        if (entry.isIntersecting) {
          setTimeout(() => entry.target.classList.add('visible'), i * 80);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    revealElements.forEach(el => observer.observe(el));
  } else {
    revealElements.forEach(el => el.classList.add('visible'));
  }

  // Animate terminal lines in sequence
  const lines = document.querySelectorAll('.terminal-body div');
  lines.forEach((line, i) => {
    line.style.opacity = '0';
    setTimeout(() => {
      line.style.transition = 'opacity 0.3s ease';
      line.style.opacity = '1';
    }, 800 + i * 200);
  });

  // Cloudflare edge metadata integration
  async function loadCloudflareMeta() {
    const statusEl = document.getElementById('cf-status');
    document.getElementById('cf-zone').textContent = window.location.hostname || 'Unknown';
    try {
      const response = await fetch('https://speed.cloudflare.com/meta');
      if (!response.ok) throw new Error(`Cloudflare metadata HTTP ${response.status}`);
      const meta = await response.json();
      document.getElementById('cf-colo').textContent = meta.colo || 'Unknown';
      const city = typeof meta.city === 'string' ? meta.city.trim() : '';
      const country = typeof meta.country === 'string' ? meta.country.trim() : '';
      let region = 'Unknown';
      if (city && country) {
        region = `${city}, ${country}`;
      } else if (city || country) {
        region = city || country;
      }
      document.getElementById('cf-region').textContent = region;
      document.getElementById('cf-asn').textContent = meta.asn || 'Unknown';
      statusEl.textContent = 'Connected';
      statusEl.style.color = 'var(--green)';
      statusEl.title = 'Successfully connected to Cloudflare edge';
    } catch (error) {
      statusEl.textContent = 'Unavailable';
      statusEl.style.color = 'var(--red)';
      statusEl.title = 'Cloudflare metadata unavailable';
    }
  }

  loadCloudflareMeta();

  // ── ACCESS MODAL ──
  (function () {
    const backdrop  = document.getElementById('access-modal');
    const modal     = backdrop.querySelector('.modal');
    const form      = document.getElementById('modal-form');
    const success   = document.getElementById('modal-success');
    const tierEl    = document.getElementById('modal-tier');
    const descEl    = document.getElementById('modal-desc');
    const submitBtn = document.getElementById('modal-submit');
    const emailInput = document.getElementById('modal-email');
    const nameInput  = document.getElementById('modal-name');

    const TIER_DESCS = {
      developer: 'Get started free — 10k verified requests per month included. We\'ll follow up within one business day.',
      pro:       'Start your Pro trial — 500k requests, advanced DRS, and priority residential nodes. First 50 developers get 3 months free.',
      enterprise:'Contact our team about Enterprise pricing — dedicated node pool, custom PoA policy rules, and SLA guarantee.',
      general:   'Join the early access list. First 50 developers get Pro free for 3 months. We\'ll follow up within one business day.',
    };

    // Focus management
    let previousFocus = null;

    function getFocusable() {
      return Array.from(modal.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ));
    }

    function openModal(tier) {
      tier = tier || 'general';
      previousFocus = document.activeElement;
      // Reset state
      form.style.display = '';
      success.classList.remove('visible');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send request';
      form.reset();
      // Pre-select tier and set description
      if (tierEl.querySelector('[value="' + tier + '"]')) tierEl.value = tier;
      descEl.textContent = TIER_DESCS[tier] || TIER_DESCS.general;
      backdrop.classList.add('open');
      document.body.style.overflow = 'hidden';
      setTimeout(() => nameInput.focus(), 50);
    }

    function closeModal() {
      backdrop.classList.remove('open');
      document.body.style.overflow = '';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send request';
      if (previousFocus) { previousFocus.focus(); previousFocus = null; }
    }

    // Wire all modal trigger buttons
    document.querySelectorAll('[data-modal]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        openModal(btn.getAttribute('data-modal'));
      });
    });

    // Close controls
    document.getElementById('modal-close-btn').addEventListener('click', closeModal);
    document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeModal();
    });

    // Keyboard: Escape to close, Tab/Shift+Tab focus trap
    document.addEventListener('keydown', function (e) {
      if (!backdrop.classList.contains('open')) return;
      if (e.key === 'Escape') { closeModal(); return; }
      if (e.key === 'Tab') {
        const focusable = getFocusable();
        if (!focusable.length) return;
        const first = focusable[0];
        const last  = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
        }
      }
    });

    // Form submit — browser validates required + email format; opens mailto draft
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      submitBtn.disabled = true;
      submitBtn.textContent = 'Opening draft…';
      const name  = nameInput.value.trim();
      const email = emailInput.value.trim();
      const tier    = tierEl.options[tierEl.selectedIndex].text;
      const notes   = document.getElementById('modal-notes').value.trim();
      const subject = encodeURIComponent('Banproof access request — ' + tier);
      const body    = encodeURIComponent(
        'Name: ' + name + '\nEmail: ' + email + '\nPlan: ' + tier +
        (notes ? '\n\nNotes:\n' + notes : '')
      );
      window.location.href = 'mailto:hello@rmarston.com?subject=' + subject + '&body=' + body;
      setTimeout(function () {
        form.style.display = 'none';
        document.getElementById('modal-success-email').textContent = email;
        success.classList.add('visible');
      }, 400);
    });
  }());
