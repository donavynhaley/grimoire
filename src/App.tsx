import { FormEvent, useState } from "react";

type Idea = {
  id: number;
  title: string;
};

const navigation = ["overview", "direction", "outcomes", "ideas", "assets", "playtests"];

const teamWork = [
  {
    owner: "Donavyn",
    discipline: "code + integration",
    task: "Connect Sight discoveries to journal knowledge",
    state: "doing",
  },
  {
    owner: "Frankie",
    discipline: "story + quests",
    task: "Shape the first tower discovery",
    state: "review",
  },
  {
    owner: "Kamryn",
    discipline: "3d art",
    task: "Model the elemental source prop",
    state: "ready",
  },
];

const pipeline = [
  { label: "model", owner: "Kamryn", state: "doing" },
  { label: "texture", owner: "unassigned", state: "waiting" },
  { label: "godot import", owner: "Donavyn", state: "waiting" },
  { label: "in-game review", owner: "team", state: "waiting" },
];

export function App() {
  const [activeView, setActiveView] = useState("overview");
  const [ideaText, setIdeaText] = useState("");
  const [ideas, setIdeas] = useState<Idea[]>([
    { id: 1, title: "Let awakened objects remember previous wizards" },
    { id: 2, title: "A spell should leave physical evidence in the room" },
  ]);

  const addIdea = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = ideaText.trim();
    if (!title) return;
    setIdeas((current) => [{ id: Date.now(), title }, ...current]);
    setIdeaText("");
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#overview" onClick={() => setActiveView("overview")}>
          <span className="brand-mark" aria-hidden="true">
            g
          </span>
          <span>grimoire</span>
        </a>
        <div className="project-name">wizard simulator</div>
        <div className="connection">
          <span className="connection-dot" />
          project online
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <nav aria-label="Project navigation">
            {navigation.map((item) => (
              <button
                className={`nav-item ${activeView === item ? "active" : ""}`}
                key={item}
                onClick={() => setActiveView(item)}
                type="button"
              >
                <span>{item}</span>
                {item === "ideas" && <span className="nav-count">{ideas.length}</span>}
              </button>
            ))}
          </nav>

          <div className="sidebar-bottom">
            <button className="nav-item" onClick={() => setActiveView("my work")} type="button">
              <span>my work</span>
              <span className="nav-count">3</span>
            </button>
            <div className="member-stack" aria-label="Project members">
              <span>D</span>
              <span>F</span>
              <span>K</span>
              <small>3 collaborators</small>
            </div>
          </div>
        </aside>

        <main className="main-content">
          <section className="page-heading">
            <div>
              <p className="eyebrow">current direction</p>
              <h1>Make Wizard Sight essential, strange, and useful.</h1>
              <p className="heading-copy">
                Build one complete investigation that cannot be solved through ordinary observation.
              </p>
            </div>
            <span className="focus-chip">active focus</span>
          </section>

          <form className="capture" onSubmit={addIdea}>
            <label htmlFor="idea-capture">capture an idea</label>
            <div className="capture-row">
              <input
                id="idea-capture"
                onChange={(event) => setIdeaText(event.target.value)}
                placeholder="Write it down without committing to it..."
                type="text"
                value={ideaText}
              />
              <button type="submit">save idea</button>
            </div>
          </form>

          <section className="content-grid">
            <article className="panel milestone-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">current milestone</p>
                  <h2>Wizard Sight vertical slice</h2>
                </div>
                <span className="state active">active</span>
              </div>
              <p className="panel-description">
                The player discovers, understands, and changes one hidden elemental relationship.
              </p>
              <ul className="conditions">
                <li className="complete">Sight has a distinct visual identity</li>
                <li className="complete">Elements can move between sources</li>
                <li>Knowledge changes what the player can perceive</li>
                <li>One complete discovery is ready for playtesting</li>
              </ul>
            </article>

            <article className="panel idea-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">idea inbox</p>
                  <h2>{ideas.length} ideas waiting</h2>
                </div>
                <button className="text-button" onClick={() => setActiveView("ideas")} type="button">
                  sort ideas
                </button>
              </div>
              <div className="idea-list">
                {ideas.slice(0, 3).map((idea) => (
                  <div className="idea-row" key={idea.id}>
                    <span className="idea-glyph">+</span>
                    <span>{idea.title}</span>
                  </div>
                ))}
              </div>
            </article>
          </section>

          <section className="section-block">
            <div className="section-heading">
              <div>
                <p className="eyebrow">team focus</p>
                <h2>What everyone is working on</h2>
              </div>
              <button className="text-button" onClick={() => setActiveView("my work")} type="button">
                open my work
              </button>
            </div>
            <div className="work-list">
              {teamWork.map((work) => (
                <article className="work-row" key={work.owner}>
                  <div className="avatar">{work.owner[0]}</div>
                  <div className="work-owner">
                    <strong>{work.owner}</strong>
                    <span>{work.discipline}</span>
                  </div>
                  <div className="work-task">{work.task}</div>
                  <span className={`state ${work.state}`}>{work.state}</span>
                </article>
              ))}
            </div>
          </section>

          <section className="section-block">
            <div className="section-heading">
              <div>
                <p className="eyebrow">asset handoff</p>
                <h2>Elemental source prop</h2>
              </div>
              <span className="muted">linked to Wizard Sight vertical slice</span>
            </div>
            <div className="pipeline">
              {pipeline.map((stage, index) => (
                <div className="pipeline-stage" key={stage.label}>
                  <div className={`stage-marker ${stage.state}`}>{index + 1}</div>
                  <strong>{stage.label}</strong>
                  <span>{stage.owner}</span>
                </div>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

