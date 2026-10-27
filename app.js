const STATUS = {
  complete: "Done",
  in_progress: "In progress",
  remaining: "Still needed",
};

const state = { filter: "all", query: "" };

function tidy(value) {
  return String(value ?? "").replace(/:(\S)/g, ": $1");
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function displayName(name) {
  const [last, first] = String(name).split(",").map((part) => part.trim());
  return first && last ? `${first} ${last}` : name;
}

function prettyDate(value) {
  const match = String(value).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return value;
  const date = new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]));
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function classYear(value) {
  return String(value).replace(/^\d+\s*-\s*/, "");
}

function walk(requirements, visit, trail = []) {
  requirements.forEach((req, index) => {
    const path = trail.concat(index);
    visit(req, path);
    walk(req.children || [], visit, path);
  });
}

function leaves(block) {
  const found = [];
  walk(block.requirements, (req) => {
    if ((req.children || []).length === 0) found.push(req);
  });
  return found;
}

function haystack(req) {
  const courses = (req.courses || []).map((course) => `${course.code} ${course.title}`).join(" ");
  const options = (req.options || []).map((option) => option.title).join(" ");
  return `${req.title} ${(req.advice || []).join(" ")} ${courses} ${options}`.toLowerCase();
}

function isVisible(req, query, filter, inherited) {
  const textHit = !query || inherited || haystack(req).includes(query);
  const childVisible = (req.children || []).some((child) => isVisible(child, query, filter, textHit || inherited));
  const statusOk = filter === "all" || req.status === filter || childVisible;
  const queryOk = !query || textHit || childVisible || inherited;
  return statusOk && queryOk;
}

function gradeClass(grade) {
  if (grade === "IP") return "ip";
  if (/^A/.test(grade)) return "good";
  if (/^[DW]/.test(grade)) return "low";
  return "";
}

function courseRow(course) {
  const bits = [`${esc(course.credits)} cr`, esc(course.term)].filter((bit) => bit && !bit.startsWith(" cr"));
  const satisfied = course.satisfied_by ? `<div class="satisfied">Satisfied by ${esc(course.satisfied_by)}</div>` : "";
  return `<li>
    <span class="code">${esc(course.code)}</span>
    <span class="title">${esc(tidy(course.title))}</span>
    <span class="grade ${gradeClass(course.grade)}">${esc(course.grade)}</span>
    <div class="meta">${bits.join(" · ")}</div>
    ${satisfied}
  </li>`;
}

function requirementHtml(req, blockTitle, path, query, filter, depth, inherited) {
  if (!isVisible(req, query, filter, inherited)) return "";
  const id = `req-${slug(blockTitle)}-${path.join("-")}`;
  const tag = depth === 0 ? "h3" : "h4";
  const parentHit = !query || haystack(req).includes(query);
  const kids = (req.children || [])
    .map((child, index) => requirementHtml(child, blockTitle, path.concat(index), query, filter, depth + 1, inherited || parentHit))
    .join("");
  const advice = (req.advice || [])
    .filter((line) => !req.reference || !line.startsWith("See "))
    .map((line) => `<p class="advice">${esc(line)}</p>`)
    .join("");
  const reference = req.reference
    ? `<a class="ref" href="#block-${slug(req.reference)}">Open the ${esc(req.reference)} section</a>`
    : "";
  const courses = (req.courses || []).length
    ? `<ul class="courses">${req.courses.map(courseRow).join("")}</ul>`
    : "";
  const options = (req.options || []).length
    ? `<div class="options chips">${req.options.map((option) => `<span class="chip">${esc(option.title)}</span>`).join("")}</div>`
    : "";
  const children = kids.trim() ? `<div class="children">${kids}</div>` : "";
  return `<article class="req ${req.status}" id="${id}">
    <div class="req-head">
      <span class="mark" aria-hidden="true"></span>
      <div>
        <${tag}>${esc(tidy(req.title))}</${tag}>
        <p class="status-label">${STATUS[req.status]}</p>
      </div>
    </div>
    ${advice}${reference}${options}${courses}${children}
  </article>`;
}

function blockVisible(block, query, filter) {
  return block.requirements.some((req) => isVisible(req, query, filter, false));
}

function blockHtml(block, query, filter) {
  if (!blockVisible(block, query, filter)) return "";
  const counts = { complete: 0, in_progress: 0, remaining: 0 };
  leaves(block).forEach((req) => {
    if (!req.reference) counts[req.status] += 1;
  });
  const countHtml = ["in_progress", "remaining", "complete"]
    .filter((key) => counts[key])
    .map((key) => `<span class="count ${key}">${counts[key]} ${STATUS[key].toLowerCase()}</span>`)
    .join("");
  const meta = block.meta || {};
  const applied = Number(meta.credits_applied);
  const required = Number(meta.credits_required);
  const meter = required
    ? `<div class="meter"><p>${esc(meta.credits_applied)} of ${esc(meta.credits_required)} credits</p><div class="bar"><span style="width:${Math.min(100, (applied / required) * 100)}%"></span></div></div>`
    : "";
  const facts = [meta.gpa ? `GPA ${esc(meta.gpa)}` : "", meta.catalogue_year ? esc(meta.catalogue_year) : ""]
    .filter(Boolean)
    .join(" · ");
  const reqs = block.requirements
    .map((req, index) => requirementHtml(req, block.title, [index], query, filter, 0))
    .join("");
  return `<section class="block" id="block-${slug(block.title)}">
    <div class="block-head">
      <div>
        <p class="kicker">${esc(block.status.charAt(0).toUpperCase() + block.status.slice(1))} ${facts ? "· " + facts : ""}</p>
        <h2>${esc(block.title)}</h2>
      </div>
      <div class="counts">${countHtml}</div>
    </div>
    ${meter}
    ${reqs}
  </section>`;
}

function checklistItems(blocks, query, filter) {
  const wanted = filter === "all" ? ["remaining", "in_progress"] : [filter];
  const items = [];
  blocks.forEach((block) => {
    walk(block.requirements, (req, path) => {
      if ((req.children || []).length || req.reference) return;
      if (!wanted.includes(req.status)) return;
      if (query && !haystack(req).includes(query) && !block.title.toLowerCase().includes(query)) return;
      items.push({ req, block: block.title, id: `req-${slug(block.title)}-${path.join("-")}` });
    });
  });
  return items;
}

function courseUses(course) {
  const uses = [];
  AUDIT.blocks.forEach((block) => {
    let hit = false;
    walk(block.requirements, (req) => {
      if (req.reference) return;
      if ((req.courses || []).some((item) => item.code === course.code && item.term === course.term)) hit = true;
    });
    if (hit) uses.push(block.title);
  });
  return uses;
}

function termCards(section) {
  return section.courses.map((course) => {
    const uses = courseUses(course);
    const where = uses.length ? `<div class="chips">${uses.map((use) => `<span class="chip">${esc(use)}</span>`).join("")}</div>` : "";
    return `<article class="term-card">
      <div class="code">${esc(course.code)}</div>
      <h3>${esc(tidy(course.title))}</h3>
      <div class="chips"><span class="chip">${esc(course.credits)} cr</span><span class="chip">${esc(course.term)}</span></div>
      ${where}
    </article>`;
  }).join("");
}

function courseSection(section, query) {
  const courses = section.courses.filter((course) => {
    if (!query) return true;
    return `${course.code} ${course.title}`.toLowerCase().includes(query);
  });
  if (!courses.length) return "";
  const meta = section.meta || {};
  const note = [meta.credits_applied ? `${meta.credits_applied} credits` : "", meta.classes_applied ? `${meta.classes_applied} classes` : ""]
    .filter(Boolean)
    .join(" · ");
  return `<section class="other">
    <h2>${esc(section.title)}</h2>
    <p class="section-note">${esc(note)}</p>
    <ul class="courses">${courses.map(courseRow).join("")}</ul>
  </section>`;
}

function leafTotals(blocks) {
  const counts = { complete: 0, in_progress: 0, remaining: 0 };
  blocks.forEach((block) => {
    leaves(block).forEach((req) => {
      if (!req.reference) counts[req.status] += 1;
    });
  });
  return counts;
}

function render() {
  const audit = window.AUDIT;
  const student = audit.student;
  const query = state.query.trim().toLowerCase();
  const filter = state.filter;
  const progress = Object.fromEntries((audit.progress || []).map((item) => [item.label, item.value]));
  const degree = audit.blocks[0];
  const creditsApplied = degree.meta.credits_applied;
  const creditsRequired = degree.meta.credits_required;
  const counts = leafTotals(audit.blocks);
  const checklist = checklistItems(audit.blocks, query, filter);
  const checklistNote = filter === "complete"
    ? "Requirements the audit already counts as finished."
    : filter === "in_progress"
    ? "These should finish once the classes in progress are done."
    : "Each line is one open requirement. Catamount Core and the distribution block sometimes list the same kind of course.";
  const checklistTitle = {
    complete: "Already finished",
    in_progress: "Currently finishing",
    remaining: "Still needed",
    all: "Still open",
  }[filter];
  const inProgress = (audit.sections || []).find((section) => section.title === "In-progress");
  const others = (audit.sections || []).filter((section) => section.title !== "In-progress");
  const showOthers = filter === "all";

  const filters = [
    ["all", "All", counts.complete + counts.in_progress + counts.remaining],
    ["remaining", "Still needed", counts.remaining],
    ["in_progress", "In progress", counts.in_progress],
    ["complete", "Done", counts.complete],
  ];

  const scrollY = window.scrollY;
  document.getElementById("app").innerHTML = `
    <header class="hero">
      <div class="wrap">
        <p class="eyebrow">College planner</p>
        <h1>The rest of college</h1>
        <p class="who">${esc(displayName(student.name))} <span>· ${esc(classYear(student.class))} · ${esc(student.college)}</span></p>
        <p class="program">${esc(student.degree)} · ${esc(student.major)} major · ${esc(String(student.concentration).replace(/^Music:\s*/, ""))} · ${esc(student.minor)} minor</p>
        <p class="fine">Advisors ${esc(student.advisors)} · Audit ${esc(prettyDate(audit.audit_date))}</p>
      </div>
    </header>
    <div class="wrap">
      <section class="stats" aria-label="Degree progress">
        <article class="stat">
          <p>Requirements</p>
          <strong>${progress.Requirements || 0}%</strong>
          <div class="bar"><span style="width:${progress.Requirements || 0}%"></span></div>
        </article>
        <article class="stat">
          <p>Credits</p>
          <strong>${esc(creditsApplied)}<span style="font-size:1rem;color:var(--muted)"> / ${esc(creditsRequired)}</span></strong>
          <div class="bar"><span style="width:${progress.Credits || 0}%"></span></div>
        </article>
        <article class="stat">
          <p>Overall GPA</p>
          <strong>${esc(audit.gpa)}</strong>
          <div class="bar"><span style="width:${Math.min(100, (Number(audit.gpa) / 4) * 100)}%"></span></div>
        </article>
      </section>
      <main class="main">
        <h2 class="section-label">This semester</h2>
        <p class="section-note">${inProgress ? `${esc(inProgress.meta.classes_applied)} classes · ${esc(inProgress.meta.credits_applied)} credits in progress` : ""}</p>
        <div class="term-grid">${inProgress ? termCards(inProgress) : ""}</div>

        <div class="toolbar">
          <div class="filters" role="group" aria-label="Filter requirements">
            ${filters.map(([id, label, count]) => `<button type="button" data-filter="${id}" aria-pressed="${filter === id}">${label} <small>${count}</small></button>`).join("")}
          </div>
          <input class="search" type="search" placeholder="Search courses or requirements" value="${esc(state.query)}" aria-label="Search courses or requirements">
        </div>

        <h2 class="section-label">${checklistTitle}</h2>
        <p class="section-note">${checklist.length ? checklistNote : "Nothing in this view."}</p>
        <div class="check-grid">
          ${checklist.map((item) => `<a class="check-card" href="#${item.id}">
            <p class="where">${esc(item.block)} · ${STATUS[item.req.status]}</p>
            <h3>${esc(tidy(item.req.title))}</h3>
            <p>${esc((item.req.advice || [])[0] || "")}</p>
          </a>`).join("") || `<p class="empty">No requirements match.</p>`}
        </div>

        <h2 class="section-label">Full audit</h2>
        <nav class="jump" aria-label="Audit sections">
          ${audit.blocks.map((block) => `<a href="#block-${slug(block.title)}">${esc(block.title)}</a>`).join("")}
        </nav>
        ${audit.blocks.map((block) => blockHtml(block, query, filter)).join("") || `<p class="empty">No sections match.</p>`}
        ${showOthers ? others.map((section) => courseSection(section, query)).join("") : ""}
      </main>
      <footer class="colophon">Read from the DegreeWorks audit pulled on ${esc(prettyDate(audit.audit_date))}. In-progress classes are included.</footer>
    </div>
  `;

  window.scrollTo(0, scrollY);
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      render();
    });
  });
  const search = document.querySelector(".search");
  search.addEventListener("input", () => {
    state.query = search.value;
    const caret = search.selectionStart;
    render();
    const next = document.querySelector(".search");
    next.focus();
    next.setSelectionRange(caret, caret);
  });
}

render();
