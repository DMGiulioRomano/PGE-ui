/* @jsx React.createElement */
const { useState: useStateSB } = React;

function SampleBrowser({
  mediaList, projectsList, onRefreshMedia, onRefreshProjects,
  activeSample, onSelectSample,
  activeProject, onSelectProject, onNewProject,
  showWaveform,
  onChooseMediaFolder, onChooseProjectsFolder,
}) {
  const { Icon } = window.PGE;
  const [query, setQuery] = useStateSB("");
  const [projectQuery, setProjectQuery] = useStateSB("");
  const [tab, setTab] = useStateSB("media");

  const samples = mediaList?.files || [];
  const projects = projectsList?.files || [];
  const mediaPath = mediaList?.path;
  const projectsPath = projectsList?.path;
  const filtered = samples.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()));
  const filteredProjects = projects.filter((p) => p.name.toLowerCase().includes(projectQuery.toLowerCase()));

  function FolderRow({ path, kind, onChoose, onRefresh, loading, error }) {
    return (
      <div className="bw-folder">
        <Icon name="folder" size={10} />
        <span className="bw-folder-path mono" title={path || "no folder chosen"}>
          {error
            ? <span className="bw-folder-err">{error}</span>
            : (path || <span className="bw-folder-empty">no folder · click to choose…</span>)}
        </span>
        <button className="bw-folder-btn" onClick={onRefresh} title="refresh" disabled={loading}>
          <svg width="10" height="10" viewBox="0 0 12 12" style={{ animation: loading ? "spnSpin 0.7s linear infinite" : "none" }}>
            <path d="M9.5,6 A3.5,3.5 0 1,1 6,2.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
            <path d="M6,1.5 L9,2.5 L9,4.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button className="bw-folder-btn" onClick={onChoose} title="change folder…">
          <svg width="8" height="8" viewBox="0 0 8 8"><circle cx="2" cy="4" r="0.8" fill="currentColor"/><circle cx="4" cy="4" r="0.8" fill="currentColor"/><circle cx="6" cy="4" r="0.8" fill="currentColor"/></svg>
        </button>
      </div>
    );
  }

  function EmptyChoose({ kind, onChoose }) {
    return (
      <div className="bw-onboard">
        <Icon name="folder" size={28} />
        <div className="bw-onboard-t">no {kind} folder yet</div>
        <div className="bw-onboard-m mono">
          {kind === "media" ? "pick the refs/ folder of your project" : "pick the configs/ folder of your project"}
        </div>
        <button className="bw-onboard-btn" onClick={onChoose}>choose folder…</button>
      </div>
    );
  }

  return (
    <div className="pge-browser">
      <div className="bw-tabs">
        <button className={tab === "media" ? "on" : ""} onClick={() => setTab("media")}>
          <Icon name="folder" size={11} /> Media
        </button>
        <button className={tab === "projects" ? "on" : ""} onClick={() => setTab("projects")}>
          <Icon name="file" size={11} /> Projects
        </button>
      </div>

      {tab === "media" ? (
        mediaPath || mediaList?.loading || mediaList?.error ? (
          <>
            <FolderRow path={mediaPath} kind="media"
                       onChoose={onChooseMediaFolder} onRefresh={onRefreshMedia}
                       loading={mediaList?.loading} error={mediaList?.error} />
            <div className="search">
              <Icon name="search" size={12} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search samples…" />
            </div>
            <div className="list">
              {mediaList?.loading && filtered.length === 0 ? <div className="empty">loading…</div> :
                filtered.length === 0 ? <div className="empty">no matches</div> : null}
              {filtered.map((s) => (
                <div key={s.name}
                     className={"it" + (activeSample === s.name ? " on" : "")}
                     draggable
                     onClick={() => onSelectSample && onSelectSample(s.name)}
                     onDragStart={(e) => e.dataTransfer.setData("text/sample", s.name)}>
                  {showWaveform !== false ? (
                    <svg className="wave" viewBox="0 0 36 14" preserveAspectRatio="none">
                      <path stroke="currentColor" strokeWidth="1" fill="none" d="M0,7 3,3 6,11 9,5 12,9 15,2 18,12 21,6 24,8 27,4 30,10 33,5 36,7" />
                    </svg>
                  ) : <span className="dot-mark" />}
                  <span className="nm">{s.name}</span>
                  <span className="du">{s.duration != null ? s.duration.toFixed(2) + "s" : "—"}</span>
                </div>
              ))}
            </div>
            <div className="bw-meta">{filtered.length} of {samples.length} files</div>
          </>
        ) : <EmptyChoose kind="media" onChoose={onChooseMediaFolder} />
      ) : (
        projectsPath || projectsList?.loading || projectsList?.error ? (
          <>
            <FolderRow path={projectsPath} kind="projects"
                       onChoose={onChooseProjectsFolder} onRefresh={onRefreshProjects}
                       loading={projectsList?.loading} error={projectsList?.error} />
            <div className="search">
              <Icon name="search" size={12} />
              <input value={projectQuery} onChange={(e) => setProjectQuery(e.target.value)} placeholder="search projects…" />
            </div>
            <div className="list">
              {projectsList?.loading && filteredProjects.length === 0 ? <div className="empty">loading…</div> :
                filteredProjects.length === 0 ? <div className="empty">no projects</div> : null}
              {filteredProjects.map((p) => (
                <div key={p.name}
                     className={"it proj" + (activeProject === p.name ? " on" : "")}
                     onClick={() => onSelectProject && onSelectProject(p.name)}>
                  <Icon name="file" size={11} />
                  <span className="nm">{p.name}</span>
                  {activeProject === p.name ? <span className="du" style={{ color: "var(--accent)" }}>●</span> : null}
                </div>
              ))}
              <div className="it new" onClick={onNewProject}><Icon name="plus" size={11} /><span className="nm">new project…</span></div>
            </div>
            <div className="bw-meta">{filteredProjects.length} of {projects.length} projects</div>
          </>
        ) : <EmptyChoose kind="projects" onChoose={onChooseProjectsFolder} />
      )}
    </div>
  );
}
window.PGE.SampleBrowser = SampleBrowser;
