/* Artifactry marketing site: theme, navigation, scroll animations, docs
   helpers, the Features demos and the Request a Feature form. No dependencies. */

;(() => {
  const root = document.documentElement
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---------- Theme ----------

  const themeButtons = document.querySelectorAll('[data-theme-toggle]')
  const syncThemeLabel = () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
    themeButtons.forEach((b) => b.setAttribute('aria-label', `Switch to ${next} mode`))
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.content = root.dataset.theme === 'dark' ? '#12151c' : '#f5f6f2'
  }
  themeButtons.forEach((button) =>
    button.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem('artifactry-theme', root.dataset.theme)
      } catch (e) {
        /* storage blocked: the choice lasts for this page only */
      }
      syncThemeLabel()
    })
  )
  syncThemeLabel()

  // ---------- Navbar ----------

  const nav = document.querySelector('.nav')
  const onScroll = () => nav && nav.classList.toggle('is-scrolled', window.scrollY > 8)
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  const menuButton = document.querySelector('[data-menu-toggle]')
  const closeMenu = () => {
    if (!nav || !menuButton) return
    nav.classList.remove('menu-open')
    menuButton.setAttribute('aria-expanded', 'false')
    menuButton.setAttribute('aria-label', 'Open menu')
  }
  menuButton?.addEventListener('click', () => {
    const open = !nav.classList.contains('menu-open')
    nav.classList.toggle('menu-open', open)
    menuButton.setAttribute('aria-expanded', String(open))
    menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu')
    if (open) nav.querySelector('.nav-link')?.focus()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav?.classList.contains('menu-open')) {
      closeMenu()
      menuButton.focus()
    }
  })
  document.querySelectorAll('.nav-link').forEach((a) => a.addEventListener('click', closeMenu))

  document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = new Date().getFullYear()))

  // ---------- Reveal on scroll ----------

  const revealTargets = document.querySelectorAll('.reveal, .steps')
  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible')
            io.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    )
    revealTargets.forEach((el) => io.observe(el))
  } else {
    revealTargets.forEach((el) => el.classList.add('is-visible'))
  }

  // Cursor-follow glow on cards
  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect()
      card.style.setProperty('--mx', `${e.clientX - r.left}px`)
      card.style.setProperty('--my', `${e.clientY - r.top}px`)
    })
  })

  // Hero particles
  const particles = document.querySelector('.particles')
  if (particles && !reduceMotion) {
    for (let i = 0; i < 18; i++) {
      const p = document.createElement('span')
      p.style.left = `${Math.random() * 100}%`
      p.style.top = `${55 + Math.random() * 45}%`
      p.style.animationDelay = `${-Math.random() * 9}s`
      p.style.animationDuration = `${7 + Math.random() * 6}s`
      particles.appendChild(p)
    }
  }

  // ---------- Code blocks: copy buttons ----------

  document.querySelectorAll('.code').forEach((block) => {
    const pre = block.querySelector('pre')
    const button = block.querySelector('.copy-btn')
    if (!pre || !button) return
    button.addEventListener('click', async () => {
      const text = pre.innerText.replace(/\n$/, '')
      try {
        await navigator.clipboard.writeText(text)
      } catch (e) {
        const range = document.createRange()
        range.selectNodeContents(pre)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
        document.execCommand('copy')
        sel.removeAllRanges()
      }
      button.textContent = 'Copied'
      button.classList.add('copied')
      setTimeout(() => {
        button.textContent = 'Copy'
        button.classList.remove('copied')
      }, 1600)
    })
  })

  // ---------- Resources tabs (User Guide / MCP) ----------

  let spy // table-of-contents observer, rebuilt when the visible tab changes

  const tabs = Array.from(document.querySelectorAll('[role="tab"][data-panel]'))
  if (tabs.length) {
    const panels = tabs.map((t) => document.getElementById(t.dataset.panel))
    const select = (tab, { focus = false, updateHash = true } = {}) => {
      tabs.forEach((t, i) => {
        const on = t === tab
        t.setAttribute('aria-selected', String(on))
        t.tabIndex = on ? 0 : -1
        panels[i].hidden = !on
      })
      if (focus) tab.focus()
      if (updateHash) history.replaceState(null, '', `#${tab.dataset.hash}`)
      setupScrollSpy()
    }
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab))
      tab.addEventListener('keydown', (e) => {
        let next = null
        if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length]
        if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length]
        if (e.key === 'Home') next = tabs[0]
        if (e.key === 'End') next = tabs[tabs.length - 1]
        if (next) {
          e.preventDefault()
          select(next, { focus: true })
        }
      })
    })

    // A hash can name a tab (#guide, #mcp) or any heading inside a panel
    // (#mcp-claude). Open the panel that holds it, then scroll to it.
    const openFromHash = () => {
      const id = decodeURIComponent(location.hash.slice(1))
      if (!id) return select(tabs[0], { updateHash: false })
      const tab = tabs.find((t) => t.dataset.hash === id)
      if (tab) {
        select(tab, { updateHash: false })
        document.querySelector('.tabs')?.scrollIntoView({ block: 'start' })
        return
      }
      const target = document.getElementById(id)
      const panelIndex = panels.findIndex((p) => p && p.contains(target))
      if (panelIndex >= 0) {
        select(tabs[panelIndex], { updateHash: false })
        requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }))
      }
    }
    window.addEventListener('hashchange', openFromHash)
    openFromHash()
  }

  // Table of contents highlight
  function setupScrollSpy() {
    if (spy) spy.disconnect()
    const panel = document.querySelector('[role="tabpanel"]:not([hidden])') || document
    const links = Array.from(panel.querySelectorAll('.toc a[href^="#"]'))
    if (!links.length || !('IntersectionObserver' in window)) return
    const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]))
    spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          links.forEach((a) => a.classList.remove('active'))
          byId.get(entry.target.id)?.classList.add('active')
        })
      },
      { rootMargin: '-20% 0px -70% 0px' }
    )
    byId.forEach((_, id) => {
      const el = document.getElementById(id)
      if (el) spy.observe(el)
    })
  }
  if (!tabs.length) setupScrollSpy()

  // ---------- Features: MCP console demo ----------

  const demo = document.querySelector('[data-demo]')
  if (demo) {
    const body = demo.querySelector('.demo-body')
    const demoTabs = Array.from(demo.querySelectorAll('.demo-tab'))
    const scripts = {
      find: [
        ['u', 'You: Find the Q3 finance deck.\n\n'],
        ['c', '// the AI calls'],
        ['', '\n'],
        ['k', 'search'],
        ['', '({ '],
        ['k', 'query'],
        ['', ': '],
        ['s', '"Q3 finance deck"'],
        ['', ', '],
        ['k', 'type'],
        ['', ': '],
        ['s', '"pptx"'],
        ['', ' })\n\n'],
        ['c', '// Artifactry answers, only with what you can see'],
        ['', '\n1 result  ·  Q3 Finance Review.pptx\n  workspace: Finance  ·  tags: q3, board\n  '],
        ['s', 'https://app.artifactry.app/a/01J9X…'],
        ['', '\n  matched: keyword + semantic']
      ],
      save: [
        ['u', 'You: Save this board Q&A to Finance.\n\n'],
        ['c', '// the AI calls'],
        ['', '\n'],
        ['k', 'save'],
        ['', '({ '],
        ['k', 'file'],
        ['', ': '],
        ['s', '"board-qa.html"'],
        ['', ',\n       '],
        ['k', 'content'],
        ['', ': '],
        ['s', '"<!DOCTYPE html>…"'],
        ['', ', '],
        ['k', 'workspace'],
        ['', ': '],
        ['s', '"Finance"'],
        ['', ' })\n\n'],
        ['c', '// stored byte for byte, indexed, tagged'],
        ['', '\nSaved  ·  Board Q&A  ·  v1\n  '],
        ['s', 'https://app.artifactry.app/a/01J9Y…'],
        ['', '\n  suggested tags: board, q3, finance']
      ],
      handoff: [
        ['u', 'You: Hand the Acme research to Cursor to build the demo.\n\n'],
        ['c', '// the AI calls'],
        ['', '\n'],
        ['k', 'handoff'],
        ['', '({ '],
        ['k', 'to'],
        ['', ': '],
        ['s', '"Cursor"'],
        ['', ', '],
        ['k', 'title'],
        ['', ': '],
        ['s', '"Build the Acme demo"'],
        ['', ',\n          '],
        ['k', 'artifacts'],
        ['', ': ['],
        ['s', '"Acme competitive research"'],
        ['', '],\n          '],
        ['k', 'brief'],
        ['', ': '],
        ['s', '"Build a demo of the 3 workflows on p.4…"'],
        ['', ' })\n\n'],
        ['c', '// later, in Cursor: "open my Artifactry handoff"'],
        ['', '\nHandoff from Claude  ·  Build the Acme demo\n  1 artifact, read in full  ·  brief attached\n  '],
        ['c', 'Whatever Cursor saves links back to the research.']
      ],
      share: [
        ['u', 'You: Share it with Board prep for 7 days.\n\n'],
        ['c', '// the AI calls'],
        ['', '\n'],
        ['k', 'share'],
        ['', '({ '],
        ['k', 'artifact'],
        ['', ': '],
        ['s', '"https://app.artifactry.app/a/01J9Y…"'],
        ['', ',\n        '],
        ['k', 'team'],
        ['', ': '],
        ['s', '"Board prep"'],
        ['', ', '],
        ['k', 'expires_in_days'],
        ['', ': 7 })\n\n'],
        ['c', '// inside your organization: no prompt needed'],
        ['', '\nShared with Board prep (6 people)\n  permission: view  ·  expires in 7 days\n  '],
        ['c', 'Public links and outside emails ask you first.']
      ]
    }

    let timer = null
    const render = (name, animate) => {
      clearTimeout(timer)
      const parts = scripts[name]
      const full = parts.map(([cls, text]) => ({ cls, text }))
      if (!animate || reduceMotion) {
        body.innerHTML = full.map(({ cls, text }) => span(cls, text)).join('')
        return
      }
      let partIndex = 0
      let charIndex = 0
      const step = () => {
        let html = ''
        for (let i = 0; i < partIndex; i++) html += span(full[i].cls, full[i].text)
        if (partIndex < full.length) html += span(full[partIndex].cls, full[partIndex].text.slice(0, charIndex))
        body.innerHTML = html + '<span class="caret"></span>'
        if (partIndex >= full.length) return
        charIndex += 2
        if (charIndex > full[partIndex].text.length) {
          partIndex++
          charIndex = 0
        }
        timer = setTimeout(step, 18)
      }
      step()
    }
    const span = (cls, text) => {
      const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return cls ? `<span class="${cls}">${safe}</span>` : safe
    }
    const selectDemo = (tab, animate = true) => {
      demoTabs.forEach((t) => {
        const on = t === tab
        t.setAttribute('aria-selected', String(on))
        t.tabIndex = on ? 0 : -1
      })
      render(tab.dataset.script, animate)
    }
    demoTabs.forEach((tab, i) => {
      tab.addEventListener('click', () => selectDemo(tab))
      tab.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
        if (!d) return
        e.preventDefault()
        const next = demoTabs[(i + d + demoTabs.length) % demoTabs.length]
        next.focus()
        selectDemo(next)
      })
    })
    // Start typing only once the console scrolls into view.
    if ('IntersectionObserver' in window) {
      const once = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          selectDemo(demoTabs[0])
          once.disconnect()
        }
      })
      once.observe(demo)
      render(demoTabs[0].dataset.script, false)
    } else {
      selectDemo(demoTabs[0], false)
    }
  }

  // ---------- Home: persona tabs ----------

  document.querySelectorAll('[data-persona]').forEach((box) => {
    const tabs = Array.from(box.querySelectorAll('[role="tab"]'))
    const select = (tab) => {
      tabs.forEach((t) => {
        const on = t === tab
        t.setAttribute('aria-selected', String(on))
        t.tabIndex = on ? 0 : -1
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on
      })
    }
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab))
      tab.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
        if (!d) return
        e.preventDefault()
        const next = tabs[(i + d + tabs.length) % tabs.length]
        next.focus()
        select(next)
      })
    })
  })

  // ---------- Home: the search line in the hero types a few example asks ----------

  const typer = document.querySelector('[data-typer]')
  if (typer && !reduceMotion) {
    const lines = typer.dataset.typer.split('|')
    let line = 0
    let pos = lines[0].length
    let deleting = true
    let wait = 2200
    const tick = () => {
      const text = lines[line]
      if (deleting) {
        pos--
        if (pos <= 0) {
          deleting = false
          line = (line + 1) % lines.length
        }
      } else {
        pos++
        if (pos >= lines[line].length) {
          deleting = true
          typer.textContent = lines[line]
          setTimeout(tick, 2400)
          return
        }
      }
      typer.textContent = (deleting ? text : lines[line]).slice(0, Math.max(pos, 0))
      setTimeout(tick, deleting ? 28 : 55)
    }
    setTimeout(tick, wait)
  }

  // ---------- Features: scope picker demo ----------

  const scopeDemo = document.querySelector('[data-scopes]')
  if (scopeDemo) {
    const tools = {
      'artifact.read': ['search', 'get'],
      'artifact.write': ['save', 'create_version', 'upload_part', 'update_tags'],
      'artifact.share': ['share', 'revoke_share'],
      'workspace.read': ['list_workspaces'],
      'team.read': ['list_teams'],
      'tags.read': ['list_tags']
    }
    const out = scopeDemo.querySelector('.scope-out')
    const update = () => {
      const on = Array.from(scopeDemo.querySelectorAll('.scope[aria-pressed="true"]')).map((b) => b.dataset.scope)
      const allowed = on.flatMap((s) => tools[s] || [])
      out.textContent = allowed.length
        ? `This app may call: ${allowed.join(', ')}`
        : 'This app can call nothing. Every tool needs a scope.'
    }
    scopeDemo.querySelectorAll('.scope').forEach((b) =>
      b.addEventListener('click', () => {
        b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')
        update()
      })
    )
    update()
  }

  // ---------- Request a Feature form (posts straight to Splitforms) ----------

  const form = document.getElementById('feature-form')
  if (form) {
    const button = form.querySelector('button[type="submit"]')
    const status = document.getElementById('form-status')
    const success = document.getElementById('form-success')
    const showError = (message) => {
      status.textContent = message
      status.className = 'form-status error'
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      // Keep the element before any await: event.currentTarget is null afterwards.
      const formEl = event.currentTarget
      if (!formEl.reportValidity()) return

      button.disabled = true
      button.classList.add('loading')
      status.textContent = ''
      status.className = 'form-status'
      success.hidden = true

      try {
        const res = await fetch('https://splitforms.com/api/submit', {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: new FormData(formEl)
        })
        const data = await res.json()
        if (data.success === true) {
          formEl.reset()
          success.hidden = false
          success.focus()
        } else {
          showError(data.message || "Couldn't send. Please try again.")
        }
      } catch (err) {
        showError("Couldn't send. Please try again.")
      } finally {
        button.disabled = false
        button.classList.remove('loading')
      }
    })
  }

  // ---------- User guide animations ----------
  // Short screen recordings play muted and looped while on screen, pause when
  // scrolled away, and wait for a click when the visitor prefers less motion.

  const clips = document.querySelectorAll('video[data-clip]')
  clips.forEach((video) => {
    const figure = video.closest('figure')
    const setState = () => figure?.classList.toggle('is-paused', video.paused)
    video.addEventListener('play', setState)
    video.addEventListener('pause', setState)
    video.addEventListener('click', () => {
      video.dataset.userPaused = video.paused ? '' : '1'
      if (video.paused) video.play().catch(() => {})
      else video.pause()
    })
    video.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        video.click()
      }
    })
    setState()
  })
  if (clips.length && !reduceMotion && 'IntersectionObserver' in window) {
    const watcher = new IntersectionObserver(
      (entries) =>
        entries.forEach(({ target, isIntersecting }) => {
          if (isIntersecting && !target.dataset.userPaused) target.play().catch(() => {})
          else if (!isIntersecting) target.pause()
        }),
      { threshold: 0.5 }
    )
    clips.forEach((video) => watcher.observe(video))
  }
})()
