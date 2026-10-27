#!/usr/bin/env python3
"""Parse a DegreeWorks audit HTML export into audit-data.js for the planner."""

import json
import re
import sys
from pathlib import Path

from bs4 import BeautifulSoup, Tag

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "Reference" / "degreeaudit.html"
OUT = ROOT / "audit-data.js"

STATUS_ICONS = {
    "ds-check-feedback": "complete",
    "ds-partial": "in_progress",
    "ds-circle": "remaining",
}

COURSE_LABELS = {"Course", "Title", "Grade", "Credits", "Term", "Repeated"}
LIST_SECTIONS = {"Electives", "In-progress", "Not Counted"}


def classes(el):
    if not isinstance(el, Tag):
        return []
    return el.get("class") or []


def has_class(el, name):
    return name in classes(el)


def text_of(el):
    if el is None:
        return ""
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip()


def status_from_svg(svg):
    if svg is None:
        return None
    for name, status in STATUS_ICONS.items():
        if has_class(svg, name):
            return status
    return None


def direct_child(el, class_name):
    for child in el.children:
        if isinstance(child, Tag) and has_class(child, class_name):
            return child
    return None


def in_nested_accordion(el, boundary):
    """True when el sits inside a requirement accordion that is inside boundary."""
    node = el.parent if isinstance(el, Tag) else el
    while isinstance(node, Tag) and node is not boundary:
        if has_class(node, "MuiAccordion-root"):
            return True
        node = node.parent
    return False


def own_descendants(boundary):
    for el in boundary.descendants:
        if isinstance(el, Tag) and not in_nested_accordion(el, boundary):
            yield el


META_LABELS = {
    "Credits required": "credits_required",
    "Credits applied": "credits_applied",
    "Classes applied": "classes_applied",
    "Catalogue Year": "catalogue_year",
    "GPA": "gpa",
}


def meta_from(container):
    meta = {}
    if container is None:
        return meta
    for span in container.find_all("span"):
        if in_nested_accordion(span, container):
            continue
        label = text_of(span).rstrip(":").strip()
        key = META_LABELS.get(label)
        if not key or key in meta:
            continue
        parent = span.parent if isinstance(span.parent, Tag) else None
        if parent is None:
            continue
        value = text_of(parent).replace(text_of(span), "", 1).strip(" :")
        if value and len(value) < 40:
            meta[key] = value
    return meta


def clean_phrase(text):
    text = text.replace("PSEUDO @", "the audition milestone")
    text = text.replace("@ @", "any course")
    text = re.sub(r"(?<![A-Za-z0-9])@(?![A-Za-z0-9])", "any course", text)
    text = re.sub(r"(\d)@", r"\1xxx", text)
    text = text.replace("and and", "and")
    text = re.sub(r"\battribute\s*=\s*", "", text)
    text = re.sub(r"\bwith ([A-Z][A-Z0-9]{1,4})\b", r"with the \1 attribute", text)
    text = text.replace("discipline =", "subject")
    text = text.replace("course number =", "")
    text = text.replace(" additionally ", ". Additionally ")
    text = re.sub(r"\s+", " ", text).strip(" :.")
    text = re.sub(r"\s+,", ",", text)
    return text


def parse_course_grid(grid):
    items = [
        child
        for child in grid.children
        if isinstance(child, Tag) and has_class(child, "MuiGrid-item")
    ]
    course = {}
    i = 0
    while i < len(items):
        label = text_of(items[i])
        if label in COURSE_LABELS and i + 1 < len(items):
            value = text_of(items[i + 1])
            course[label.lower()] = value
            i += 2
            continue
        blob = text_of(items[i])
        if blob.lower().startswith("satisfied by:"):
            course["satisfied_by"] = blob.split(":", 1)[1].strip()
        i += 1
    if "course" not in course:
        return None
    return {
        "code": re.sub(r"\s+", " ", course.get("course", "")).strip(),
        "title": course.get("title", ""),
        "grade": course.get("grade", ""),
        "credits": course.get("credits", "").strip("()"),
        "term": course.get("term", ""),
        "repeated": course.get("repeated", ""),
        "satisfied_by": course.get("satisfied_by", ""),
    }


def courses_in(boundary):
    found = []
    for el in own_descendants(boundary):
        if not has_class(el, "MuiGrid-container"):
            continue
        labels = [
            text_of(child)
            for child in el.children
            if isinstance(child, Tag) and has_class(child, "MuiGrid-item")
        ]
        if "Course" in labels and "Title" in labels:
            course = parse_course_grid(el)
            if course:
                found.append(course)
    return found


def inside_course_grid(el):
    node = el if isinstance(el, Tag) else el.parent
    while isinstance(node, Tag):
        if has_class(node, "MuiGrid-container"):
            labels = [
                text_of(child)
                for child in node.children
                if isinstance(child, Tag) and has_class(child, "MuiGrid-item")
            ]
            if "Course" in labels and "Title" in labels:
                return True
        node = node.parent
    return False


def options_in(boundary):
    """Choice rows such as language tracks, which are not full accordions."""
    options = []
    seen = set()
    for grid in own_descendants(boundary):
        if not has_class(grid, "MuiGrid-container"):
            continue
        labels = [
            text_of(child)
            for child in grid.children
            if isinstance(child, Tag) and has_class(child, "MuiGrid-item")
        ]
        if "Course" in labels and "Title" in labels:
            continue
        icon = None
        for svg in grid.find_all("svg"):
            if status_from_svg(svg) is None:
                continue
            nearest = svg.find_parent("div", class_=lambda c: c and "MuiGrid-container" in c)
            if nearest is grid:
                icon = svg
                break
        if icon is None:
            continue
        title = ""
        for p in grid.find_all("p"):
            nearest = p.find_parent("div", class_=lambda c: c and "MuiGrid-container" in c)
            if nearest is not grid:
                continue
            raw = clean_phrase(text_of(p))
            if raw and raw not in COURSE_LABELS and not raw.startswith("Still needed"):
                title = raw
                break
        if not title or title in seen or len(title) > 90:
            continue
        seen.add(title)
        options.append({"title": title, "status": status_from_svg(icon)})
    return options


def advice_in(boundary):
    chunks = []
    paragraphs = [
        el
        for el in own_descendants(boundary)
        if el.name == "p" and not inside_course_grid(el)
    ]
    index = 0
    while index < len(paragraphs):
        raw = text_of(paragraphs[index])
        if raw == "Still needed:" and index + 1 < len(paragraphs):
            nxt = clean_phrase(text_of(paragraphs[index + 1]))
            if nxt and nxt not in chunks:
                chunks.append(nxt)
            index += 2
            continue
        if raw.startswith("Still needed:"):
            nxt = clean_phrase(raw.split(":", 1)[1])
            if nxt and nxt not in chunks:
                chunks.append(nxt)
        index += 1
    return chunks


def requirement_title(summary):
    for p in summary.find_all("p"):
        raw = clean_phrase(text_of(p))
        if raw and raw not in {"Still needed"}:
            return raw
    return clean_phrase(text_of(summary))


def parse_requirement(accordion):
    summary = direct_child(accordion, "MuiAccordionSummary-root")
    if summary is None:
        return None
    icon = summary.find("svg")
    status = status_from_svg(icon)
    if status is None:
        return None
    collapse = direct_child(accordion, "MuiCollapse-root")
    details = None
    if collapse is not None:
        details = collapse.find("div", class_=lambda c: c and "MuiAccordionDetails-root" in c)
    title = requirement_title(summary)
    children = []
    courses = []
    advice = []
    options = []
    if details is not None:
        children = child_requirements(details)
        courses = courses_in(details)
        advice = advice_in(details)
        options = options_in(details)
    reference = ""
    joined = " ".join(advice)
    match = re.search(r"See (.+?) section", joined)
    if match:
        reference = match.group(1).strip()
    return {
        "title": title,
        "status": status,
        "advice": [a for a in advice if not a.startswith(title)],
        "reference": reference,
        "courses": courses,
        "options": options,
        "children": children,
    }


def child_requirements(boundary):
    found = []
    for accordion in boundary.find_all("div", class_=lambda c: c and "MuiAccordion-root" in c):
        parent = accordion.find_parent("div", class_=lambda c: c and "MuiAccordion-root" in c)
        if parent is not None and boundary in parent.parents:
            continue
        if boundary not in accordion.parents and accordion is not boundary:
            continue
        parsed = parse_requirement(accordion)
        if parsed:
            found.append(parsed)
    return found


def parse_block(block_heading):
    block_id = block_heading.get("id", "")
    title = text_of(block_heading)
    status_el = block_heading.find_next(id=f"{block_id.replace('block-', '')}_statusLabel")
    # id is block-RA004448 and status is RA004448_statusLabel
    code = block_id.replace("block-", "")
    status_el = block_heading.find_next(id=f"{code}_statusLabel")
    status = text_of(status_el)
    accordion = block_heading.find_parent("div", class_=lambda c: c and "MuiAccordion-root" in c)
    details = None
    if accordion is not None:
        collapse = direct_child(accordion, "MuiCollapse-root")
        if collapse is not None:
            details = collapse.find("div", class_=lambda c: c and "MuiAccordionDetails-root" in c)
    meta = meta_from(details) if details is not None else {}
    requirements = child_requirements(details) if details is not None else []
    return {
        "id": code,
        "title": title,
        "status": status.lower(),
        "meta": meta,
        "requirements": requirements,
    }


def parse_course_section(heading):
    title = text_of(heading)
    card = heading.find_parent("div", class_=lambda c: c and "MuiCard-root" in c)
    details = None
    if card is not None:
        details = card.find("div", class_=lambda c: c and "MuiAccordionDetails-root" in c)
    boundary = details or card
    return {
        "title": title,
        "meta": meta_from(boundary),
        "courses": courses_in(boundary) if boundary is not None else [],
    }


def parse_student(soup):
    student = {}
    for field, key in (
        ("student-name", "name"),
        ("degree", "program"),
    ):
        el = soup.find(id=field)
        if el and el.get("value"):
            student[key] = el["value"]
    for dt in soup.find_all("dt"):
        label = text_of(dt)
        dd = dt.find_next_sibling("dd")
        if dd is not None:
            student[label.lower().replace(" ", "_")] = text_of(dd)
    progress = []
    for p in soup.find_all("p", attrs={"aria-valuenow": True}):
        node = p.parent
        caption = ""
        for _ in range(5):
            if not isinstance(node, Tag):
                break
            captions = [
                text_of(child)
                for child in node.find_all("p", recursive=False)
                if text_of(child) and not child.has_attr("aria-valuenow")
            ]
            if captions:
                caption = captions[0]
                break
            node = node.parent
        progress.append({"label": caption or "Progress", "value": int(p["aria-valuenow"])})
    # GPA sits beside the rings.
    gpa = ""
    for p in soup.find_all("p"):
        if text_of(p) == "Overall GPA":
            sibling = p.find_next_sibling("p")
            if sibling:
                gpa = text_of(sibling)
            break
    audit_date = ""
    for span in soup.find_all("span"):
        if text_of(span) == "Audit date":
            audit_date = text_of(span.parent).replace("Audit date", "").strip()
            break
    return student, progress, gpa, audit_date


def leaf_counts(requirements):
    counts = {"complete": 0, "in_progress": 0, "remaining": 0}
    def walk(nodes):
        for req in nodes:
            if req["children"]:
                walk(req["children"])
            else:
                counts[req["status"]] += 1
    walk(requirements)
    return counts


def main():
    html = SOURCE.read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(html, "html.parser")
    student, progress, gpa, audit_date = parse_student(soup)
    blocks = [parse_block(h) for h in soup.find_all(id=re.compile(r"^block-"))]
    sections = []
    for heading in soup.find_all(attrs={"role": "heading", "aria-level": "3"}):
        title = text_of(heading)
        if title in LIST_SECTIONS:
            sections.append(parse_course_section(heading))
    payload = {
        "student": student,
        "gpa": gpa,
        "audit_date": audit_date,
        "progress": progress,
        "blocks": blocks,
        "sections": sections,
    }
    OUT.write_text(
        "window.AUDIT = " + json.dumps(payload, indent=2, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )
    print(f"Wrote {OUT}")
    print(f"Student: {student.get('name')} | {student.get('program')}")
    print(f"Blocks: {len(blocks)} | course sections: {len(sections)}")
    for block in blocks:
        counts = leaf_counts(block["requirements"])
        print(
            f"  {block['title']}: {len(block['requirements'])} top-level, "
            f"leaves {counts} | {block['meta']}"
        )
        for req in block["requirements"]:
            kids = len(req["children"])
            print(f"    [{req['status']}] {req['title']} ({kids} sub, {len(req['courses'])} courses)")


if __name__ == "__main__":
    sys.exit(main())
