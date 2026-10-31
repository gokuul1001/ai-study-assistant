import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const navigation = [
  ["▦", "Dashboard"],
  ["▤", "My Knowledge"],
  ["✦", "AI Assistant"],
  ["⌕", "Smart Search"],
  ["▧", "Categories"],
  ["⚙", "Settings"]
];

const defaultSettings = {
  smartSuggestions: true,
  autoSave: true,
  notifications: true
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [authBusy, setAuthBusy] = useState(false);
  const [notes, setNotes] = useState([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("General");
  const [dashboardSearch, setDashboardSearch] = useState("");
  const [smartSearch, setSmartSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [active, setActive] = useState("Dashboard");
  const [aiInput, setAiInput] = useState("");
  const [aiMode, setAiMode] = useState("local");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatHistory, setChatHistory] = useState([]);
  const [settings, setSettings] = useState(defaultSettings);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titleRef = useRef(null);
  const chatEndRef = useRef(null);

  const loadWorkspace = async () => {
    const [notesResult, settingsResult, chatResult] = await Promise.all([
      api("/api/notes"),
      api("/api/settings"),
      api("/api/chat")
    ]);
    setNotes(notesResult.notes);
    setSettings(settingsResult.settings);
    setChatHistory(chatResult.messages);
    setAiMode(chatResult.aiMode);
  };

  const restoreDraft = (userId) => {
    try {
      const savedDraft = localStorage.getItem(`knowflow:draft:${userId}`);
      const draft = savedDraft ? JSON.parse(savedDraft) : null;
      setTitle(draft?.title || "");
      setContent(draft?.content || "");
      setCategory(draft?.category || "General");
    } catch {
      setTitle("");
      setContent("");
      setCategory("General");
    }
  };

  useEffect(() => {
    let mounted = true;
    api("/api/auth/me")
      .then(async ({ user: currentUser }) => {
        if (!mounted || !currentUser) return;
        setUser(currentUser);
        restoreDraft(currentUser.id);
        await loadWorkspace();
      })
      .catch((loadError) => {
        if (loadError.message !== "Please sign in to continue.") setError(loadError.message);
      })
      .finally(() => {
        if (mounted) setReady(true);
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatHistory, chatBusy]);

  useEffect(() => {
    if (!user || !settings.autoSave) return;
    try {
      localStorage.setItem(`knowflow:draft:${user.id}`, JSON.stringify({ title, content, category }));
    } catch (storageError) {
      console.warn("Unable to save the note draft in local storage.", storageError);
    }
  }, [user, settings.autoSave, title, content, category]);

  const categories = useMemo(
    () => ["All", ...new Set(notes.map((note) => note.category || "General"))],
    [notes]
  );
  const filteredRecentNotes = useMemo(() => notes.filter((note) => {
    const query = dashboardSearch.trim().toLowerCase();
    const matchesSearch = !query || `${note.title} ${note.content} ${note.category}`.toLowerCase().includes(query);
    return matchesSearch && (selectedCategory === "All" || note.category === selectedCategory);
  }), [dashboardSearch, notes, selectedCategory]);
  const smartSearchResults = useMemo(() => {
    const term = smartSearch.trim().toLowerCase();
    return term ? notes.filter((note) => `${note.title} ${note.content} ${note.category}`.toLowerCase().includes(term)) : notes;
  }, [notes, smartSearch]);

  const submitAuth = async (event) => {
    event.preventDefault();
    setAuthBusy(true);
    setError("");
    try {
      const endpoint = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
      const result = await api(endpoint, { method: "POST", body: JSON.stringify(authForm) });
      setUser(result.user);
      restoreDraft(result.user.id);
      await loadWorkspace();
    } catch (authError) {
      setError(authError.message);
    } finally {
      setAuthBusy(false);
      setReady(true);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
      setUser(null);
      setNotes([]);
      setChatHistory([]);
      setActive("Dashboard");
      setAuthForm({ name: "", email: "", password: "" });
      setTitle("");
      setContent("");
      setCategory("General");
      setError("");
      setNotice("");
    } catch (logoutError) {
      setError(logoutError.message);
    } finally {
      setBusy(false);
    }
  };

  const addNote = async (event) => {
    event?.preventDefault();
    if (!title.trim() || !content.trim()) {
      setError("Add a title and some content before saving your note.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/notes", {
        method: "POST",
        body: JSON.stringify({ title, content, category })
      });
      setNotes((current) => [result.note, ...current]);
      setTitle("");
      setContent("");
      setCategory("General");
      setSelectedCategory("All");
      setActive("My Knowledge");
      setNotice(settings.notifications ? "Your note was saved to the library." : "");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteNote = async (noteId) => {
    setError("");
    try {
      await api(`/api/notes/${noteId}`, { method: "DELETE" });
      setNotes((current) => current.filter((note) => note.id !== noteId));
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  const updateSetting = async (key) => {
    const nextSettings = { ...settings, [key]: !settings[key] };
    setSettings(nextSettings);
    try {
      const result = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ [key]: nextSettings[key] }) });
      setSettings(result.settings);
    } catch (settingsError) {
      setSettings(settings);
      setError(settingsError.message);
    }
  };

  const handleAskAI = async (event) => {
    event?.preventDefault();
    const question = aiInput.trim();
    if (!question || chatBusy) return;
    setAiInput("");
    setChatBusy(true);
    setError("");
    setChatHistory((current) => [...current, { id: `pending-${Date.now()}`, role: "user", content: question, createdAt: new Date().toISOString() }]);
    try {
      const result = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: question }) });
      setChatHistory((current) => [
        ...current.filter((message) => !message.id.startsWith("pending-")),
        { id: `user-${Date.now()}`, role: "user", content: question, createdAt: new Date().toISOString() },
        result.message
      ]);
      setAiMode(result.aiMode);
    } catch (chatError) {
      setChatHistory((current) => current.filter((message) => !message.id.startsWith("pending-")));
      setAiInput(question);
      setError(chatError.message);
    } finally {
      setChatBusy(false);
    }
  };

  const clearChat = async () => {
    try {
      await api("/api/chat", { method: "DELETE" });
      setChatHistory([]);
      setError("");
    } catch (chatError) {
      setError(chatError.message);
    }
  };

  if (!ready) {
    return <main className="boot-screen"><span className="loader" /><p>Opening your study space</p></main>;
  }
  if (!user) {
    return (
      <main className="auth-screen">
        <CursorAura />
        <section className="auth-aside">
          <a className="brand auth-brand" href="#home" onClick={(event) => event.preventDefault()}>
            <span className="brand-icon">✦</span>
            <span><strong>KnowFlow</strong><small>AI Study Workspace</small></span>
          </a>
          <div className="auth-message">
            <span className="eyebrow">A clearer way to learn</span>
            <h1>Make your knowledge<br />work for you.</h1>
            <p>Keep your notes close, find what matters, and turn study questions into useful next steps.</p>
            <div className="auth-orbit"><span>✦</span><i /><b /></div>
          </div>
          <small className="auth-footnote">Private by design. Your notes stay in your account.</small>
        </section>
        <section className="auth-main">
          <form className="auth-form" onSubmit={submitAuth}>
            <div className="auth-mobile-brand"><span className="brand-icon">✦</span><strong>KnowFlow</strong></div>
            <span className="eyebrow">YOUR PERSONAL STUDY SPACE</span>
            <h2>{authMode === "login" ? "Welcome back" : "Create your account"}</h2>
            <p className="auth-subtitle">{authMode === "login" ? "Sign in to pick up where you left off." : "Start building a knowledge library that belongs to you."}</p>
            {error && <div className="alert error-alert" role="alert">{error}</div>}
            {authMode === "register" && <label>Your name<input autoComplete="name" value={authForm.name} onChange={(event) => setAuthForm({ ...authForm, name: event.target.value })} required maxLength={80} placeholder="Jamie Chen" /></label>}
            <label>Email address<input type="email" autoComplete="email" value={authForm.email} onChange={(event) => setAuthForm({ ...authForm, email: event.target.value })} required maxLength={254} placeholder="you@example.com" /></label>
            <label>Password<input type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} value={authForm.password} onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })} required minLength={8} maxLength={200} placeholder="At least 8 characters" /></label>
            <button type="submit" className="primary-btn auth-submit" disabled={authBusy}>{authBusy && <span className="button-spinner" />}{authMode === "login" ? "Sign in" : "Create account"}<span>→</span></button>
            <p className="auth-switch">{authMode === "login" ? "New to KnowFlow?" : "Already have an account?"}<button type="button" onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setError(""); }}> {authMode === "login" ? "Create an account" : "Sign in"}</button></p>
          </form>
        </section>
      </main>
    );
  }

  const initials = user.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="app-shell">
      <CursorAura />
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">✦</span>
          <span><strong>KnowFlow</strong><small>AI Study Workspace</small></span>
        </div>
        <p className="nav-label">YOUR WORKSPACE</p>
        <nav className="nav-list" aria-label="Main navigation">
          {navigation.map(([icon, name]) => (
            <button key={name} type="button" className={`nav-item ${active === name ? "active" : ""}`} onClick={() => setActive(name)} aria-current={active === name ? "page" : undefined}>
              <span className="nav-icon">{icon}</span><span>{name}</span>{name === "AI Assistant" && <span className="nav-spark">✦</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note"><span className="sidebar-note-icon">✧</span><p>Your library is private to your account.</p></div>
        <div className="sidebar-bottom">
          <div className="profile-avatar">{initials}</div>
          <div className="profile-copy"><strong>{user.name}</strong><small>{user.email}</small></div>
          <button type="button" className="icon-btn logout-btn" title="Sign out" aria-label="Sign out" onClick={signOut} disabled={busy}>↗</button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><span className="breadcrumb">STUDY SPACE <span>/</span> {active.toUpperCase()}</span><h1>{active === "Dashboard" ? "Your Knowledge Hub" : active}</h1></div>
          <div className="top-actions"><span className={`status ${aiMode === "provider" ? "status-live" : ""}`}><i />{aiMode === "provider" ? "AI connected" : "Notes mode"}</span><div className="user-avatar" title={user.name}>{initials}</div><button type="button" className="mobile-logout" onClick={signOut} title="Sign out" aria-label="Sign out">↗</button></div>
        </header>

        {error && <div className="alert global-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss message">×</button></div>}
  {notice && <div className="alert success-alert global-alert" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss confirmation">×</button></div>}

        {active === "Dashboard" && <>
          <section className="welcome-card">
            <div className="welcome-copy"><span className="welcome-tag">✦ YOUR PERSONAL STUDY SPACE</span><h2>Knowledge, in focus.</h2><p>Capture what you learn, then find the connections that move you forward.</p><button type="button" className="primary-btn" onClick={() => titleRef.current?.focus()}>＋ Create a note</button></div>
            <div className="welcome-art" aria-hidden="true"><span>✦</span><i /><b>01</b></div>
          </section>
          <section className="stats-grid" aria-label="Workspace overview">
            <article className="stat-card"><span className="stat-icon">▤</span><p>Saved notes</p><h2>{notes.length}</h2><small>In your knowledge library</small></article>
            <article className="stat-card"><span className="stat-icon violet">✦</span><p>Study assistant</p><h2>{aiMode === "provider" ? "Connected" : "Ready"}</h2><small>{aiMode === "provider" ? "Generated answers enabled" : "Grounded in your notes"}</small></article>
            <article className="stat-card"><span className="stat-icon coral">⌕</span><p>Topics covered</p><h2>{Math.max(0, categories.length - 1)}</h2><small>Across your saved material</small></article>
          </section>
          <section className="workspace-grid">
            <form className="panel create-panel" onSubmit={addNote}>
              <div className="panel-heading"><div><span className="section-index">01 / CAPTURE</span><h3>Create knowledge</h3><p>Save a concept, question, or useful source.</p></div><span className="heading-icon">✎</span></div>
              <label className="sr-only" htmlFor="note-title">Note title</label><input ref={titleRef} id="note-title" placeholder="Give your note a title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required />
              <label className="sr-only" htmlFor="note-category">Category</label><input id="note-category" className="category-input" placeholder="Topic (for example, Biology)" value={category} onChange={(event) => setCategory(event.target.value)} maxLength={50} />
              <label className="sr-only" htmlFor="note-content">Note content</label><textarea id="note-content" placeholder="Write something worth remembering..." value={content} onChange={(event) => setContent(event.target.value)} maxLength={20000} required />
              <button type="submit" className="primary-btn save-btn" disabled={busy}>{busy ? <><span className="button-spinner" />Saving</> : <>Save to library <span>→</span></>}</button>
            </form>
            <section className="panel assistant-panel"><span className="section-index">02 / REFLECT</span><div className="assistant-symbol">✦</div><h3>Study with your notes</h3><p>Ask a question to retrieve relevant ideas, or connect an AI provider for generated explanations and broader study help.</p><div className="ai-feature"><span>01</span> Notes-grounded answers</div><div className="ai-feature"><span>02</span> Persistent chat history</div><button type="button" className="secondary-btn" onClick={() => setActive("AI Assistant")}>Open study assistant <span>→</span></button></section>
          </section>
          <section className="panel notes-panel"><div className="panel-heading"><div><span className="section-index">03 / RECENT</span><h3>Recently added</h3><p>Your latest saved material.</p></div><input className="search-input" aria-label="Search recent notes" placeholder="⌕  Search notes" value={dashboardSearch} onChange={(event) => setDashboardSearch(event.target.value)} /></div><NoteGrid notes={filteredRecentNotes} emptyTitle="No notes found" emptyText="Create your first knowledge note above." /></section>
        </>}

        {active === "My Knowledge" && <section className="panel page-panel"><div className="panel-heading"><div><span className="section-index">YOUR LIBRARY</span><h3>Knowledge library</h3><p>Notes saved to your personal study space.</p></div><div className="toolbar-row"><input className="search-input" aria-label="Filter notes" placeholder="Filter notes..." value={dashboardSearch} onChange={(event) => setDashboardSearch(event.target.value)} /><select className="select-input" aria-label="Filter by category" value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></div></div><NoteGrid notes={filteredRecentNotes} emptyTitle="No items match your filters" emptyText="Try a different keyword or category." onDelete={deleteNote} /></section>}

        {active === "AI Assistant" && (
          <section className="panel page-panel chat-panel">
            <div className="panel-heading chat-heading">
              <div>
                <span className="section-index">YOUR STUDY PARTNER</span>
                <h3>AI Assistant</h3>
                <p>{aiMode === "provider" ? "Generated answers grounded in your saved notes." : "Answers retrieve relevant ideas from your saved notes."}</p>
              </div>
              <button type="button" className="secondary-btn clear-chat" aria-label="Clear chat" title="Clear chat" onClick={clearChat} disabled={!chatHistory.length || chatBusy}>
                ⌫ <span>Clear chat</span>
              </button>
            </div>
            <div className="chat-box" aria-live="polite">
              {chatHistory.length === 0 && (
                <div className="chat-welcome">
                  <span className="chat-welcome-icon">✦</span>
                  <h4>What are you studying?</h4>
                  <p>Ask about your saved knowledge to get started.</p>
                  {settings.smartSuggestions && (
                    <div className="suggestion-row">
                      <button type="button" onClick={() => setAiInput("Summarize my recent notes")}>Summarize my notes <span>↗</span></button>
                      <button type="button" onClick={() => setAiInput("What topics have I saved?")}>Explore my topics <span>↗</span></button>
                    </div>
                  )}
                </div>
              )}
              {chatHistory.map((message) => (
                <div key={message.id} className={`chat-message ${message.role}`}>
                  <div className="message-avatar">{message.role === "assistant" ? "✦" : initials}</div>
                  <div className="message-body">
                    <span className="message-author">{message.role === "assistant" ? "STUDY ASSISTANT" : "YOU"}</span>
                    <p>{message.content}</p>
                    {message.sources?.length > 0 && (
                      <div className="message-sources">
                        Sources: {message.sources.map((source) => (
                          <button key={source.id} type="button" onClick={() => setActive("My Knowledge")}>{source.title}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {chatBusy && (
                <div className="chat-message assistant">
                  <div className="message-avatar">✦</div>
                  <div className="typing-indicator" aria-label="Assistant is responding"><i /><i /><i /></div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <form className="chat-input-wrap" onSubmit={handleAskAI}>
              <textarea rows="1" value={aiInput} onChange={(event) => setAiInput(event.target.value)} placeholder="Ask a question about your notes..." aria-label="Message the study assistant" maxLength={4000} onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleAskAI(event);
                }
              }} />
              <button type="submit" className="send-btn" disabled={!aiInput.trim() || chatBusy} aria-label="Send message" title="Send message">↑</button>
              <small>ENTER TO SEND <span>·</span> SHIFT + ENTER FOR A NEW LINE</small>
            </form>
          </section>
        )}

        {active === "Smart Search" && <section className="panel page-panel"><div className="panel-heading"><div><span className="section-index">FIND A CONNECTION</span><h3>Smart search</h3><p>Search titles, categories, and the full text of your notes.</p></div></div><div className="search-field"><span>⌕</span><input autoFocus className="full-width" value={smartSearch} onChange={(event) => setSmartSearch(event.target.value)} placeholder="Search your knowledge base..." aria-label="Search knowledge base" /></div><div className="result-count">{smartSearchResults.length} {smartSearchResults.length === 1 ? "result" : "results"}{smartSearch && <> for <strong>“{smartSearch}”</strong></>}</div><div className="result-list">{smartSearchResults.length === 0 ? <EmptyState icon="⌕" title="No results found" text="Try a different keyword or note title." /> : smartSearchResults.map((note) => <article className="result-item" key={note.id}><div className="result-meta">{note.category}<span>{formatDate(note.createdAt)}</span></div><h4>{note.title}</h4><p>{note.content}</p></article>)}</div></section>}

        {active === "Categories" && <section className="panel page-panel"><div className="panel-heading"><div><span className="section-index">ORGANIZE YOUR LIBRARY</span><h3>Topics and categories</h3><p>Select a topic to see its notes.</p></div></div>{categories.length <= 1 ? <EmptyState icon="▧" title="Your topics will appear here" text="Add a category when saving a note to organize your library." /> : <div className="category-grid">{categories.filter((item) => item !== "All").map((item) => <button type="button" key={item} className="category-card" onClick={() => { setSelectedCategory(item); setActive("My Knowledge"); }}><span className="category-mark">✦</span><span className="category-name">{item}</span><strong>{notes.filter((note) => note.category === item).length}</strong><small>notes <span>→</span></small></button>)}</div>}</section>}

        {active === "Settings" && <section className="panel page-panel"><div className="panel-heading"><div><span className="section-index">PREFERENCES</span><h3>Workspace settings</h3><p>Choose how your study space behaves.</p></div></div><div className="settings-grid">{[["smartSuggestions", "Smart suggestions", "Show suggested prompts in the study assistant."], ["autoSave", "Auto save", "Keep note drafts in this browser as you work."], ["notifications", "Notifications", "Show a confirmation when a note is saved."]].map(([key, label, description]) => <div className="setting-item" key={key}><div><strong>{label}</strong><p>{description}</p></div><button type="button" className={`switch ${settings[key] ? "on" : ""}`} role="switch" aria-checked={settings[key]} aria-label={label} onClick={() => updateSetting(key)}><span /></button></div>)}</div><div className="account-panel"><div className="account-avatar">{initials}</div><div><span className="section-index">SIGNED IN AS</span><strong>{user.name}</strong><p>{user.email}</p></div><button type="button" className="secondary-btn" onClick={signOut} disabled={busy}>Sign out <span>↗</span></button></div></section>}

        <footer><span>KNOWFLOW</span><span>YOUR PRIVATE STUDY SPACE</span></footer>
      </main>
    </div>
  );
}

function CursorAura() {
  const auraRef = useRef(null);

  useEffect(() => {
    const aura = auraRef.current;
    const pointerIsFine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!aura || !pointerIsFine || prefersReducedMotion) return undefined;

    let clickTimer;
    const moveWithPointer = (event) => {
      aura.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
      aura.classList.add("is-visible");
    };
    const pulseOnClick = () => {
      aura.classList.add("is-clicking");
      window.clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => aura.classList.remove("is-clicking"), 240);
    };
    const hideOnLeave = () => aura.classList.remove("is-visible");

    window.addEventListener("pointermove", moveWithPointer, { passive: true });
    window.addEventListener("pointerdown", pulseOnClick, { passive: true });
    window.addEventListener("blur", hideOnLeave);
    document.addEventListener("mouseleave", hideOnLeave);
    return () => {
      window.removeEventListener("pointermove", moveWithPointer);
      window.removeEventListener("pointerdown", pulseOnClick);
      window.removeEventListener("blur", hideOnLeave);
      document.removeEventListener("mouseleave", hideOnLeave);
      window.clearTimeout(clickTimer);
    };
  }, []);

  return (
    <div className="cursor-aura" ref={auraRef} aria-hidden="true">
      <span className="cursor-ring" />
      <span className="cursor-core" />
    </div>
  );
}

function NoteGrid({ notes, emptyTitle, emptyText, onDelete }) {
  if (!notes.length) return <EmptyState icon="▤" title={emptyTitle} text={emptyText} />;
  return <div className="notes-grid">{notes.map((note) => <article className="note-card" key={note.id}><div className="card-top-row"><span className="note-label">{note.category}</span>{onDelete && <button type="button" className="icon-btn delete-btn" onClick={() => onDelete(note.id)} title={`Delete ${note.title}`} aria-label={`Delete ${note.title}`}>×</button>}</div><h3>{note.title}</h3><p>{note.content}</p><small>Saved {formatDate(note.createdAt)}</small></article>)}</div>;
}

function EmptyState({ icon, title, text }) {
  return <div className="empty-state"><span>{icon}</span><h3>{title}</h3><p>{text}</p></div>;
}

export default App;
