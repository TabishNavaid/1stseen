/**
 * Company names, program titles, and places read as people write them: IMC, Co-op, "C++ or Python", Canada,
 * "New York, NY", and accents kept, from the company's own published title whenever one matches the stored one.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { displayCompany, displayPlace, displayTitle, foldTitle, tidyTitle } from "../lib/display-names.ts";

test("company names read as the companies write them", () => {
  assert.equal(displayCompany("Imc"), "IMC");
  assert.equal(displayCompany("Jumptrading"), "Jump Trading");
  assert.equal(displayCompany("Vercel Inc."), "Vercel");
  assert.equal(displayCompany("Hudson River Trading"), "Hudson River Trading");
  assert.equal(displayCompany("DRW"), "DRW");
  assert.equal(displayCompany("ID.me"), "ID.me");
});

test("a stored title is tidied: Co-op, joining words in lower case, and acronyms in capitals", () => {
  assert.equal(tidyTitle("Hardware Engineer Winter Co Op"), "Hardware Engineer Winter Co-op");
  assert.equal(tidyTitle("Software Developer Intern Co-Op Backend Winter"), "Software Developer Intern Co-op Backend Winter");
  assert.equal(tidyTitle("Software Engineer Intern C++ Or Python Summer"), "Software Engineer Intern C++ or Python Summer");
  assert.equal(tidyTitle("Fpga Engineer Intern"), "FPGA Engineer Intern");
  assert.equal(tidyTitle("Software Engineering Intern Ios Summer"), "Software Engineering Intern iOS Summer");
  assert.equal(tidyTitle("Quantitative Research Intern Nlp"), "Quantitative Research Intern NLP");
  assert.equal(tidyTitle("Product Designer New Grad Us Government"), "Product Designer New Grad US Government");
  assert.equal(tidyTitle("Working In Software Testing"), "Working in Software Testing");
  assert.equal(tidyTitle("Campus AI Researcher, PhD/Postdoc (Intern)"), "Campus AI Researcher, PhD/Postdoc (Intern)");
  // A title's first word keeps its capital even when it is a joining word.
  assert.equal(tidyTitle("In House Counsel Intern"), "In House Counsel Intern");
});

test("the company's own title is shown when it folds to the stored one, which brings back its accents and punctuation", () => {
  const stored = "Stagiaire En D Veloppement De Logiciels T Software Developer Intern Summer";
  const published = "Stagiaire en développement de logiciels (été) / Software Developer Intern (Summer)";
  assert.equal(foldTitle(published), foldTitle(stored));
  assert.equal(displayTitle(stored, [{ title: published, lastSeenAt: "2026-09-01T00:00:00Z" }]), published);
  // The most recently seen matching title wins; a title that does not fold to the stored one is never used.
  assert.equal(
    displayTitle("Software Engineer Intern C++ Or Python Summer", [
      { title: "Software Engineer Intern (C++ or Python) - Summer", lastSeenAt: "2026-01-01T00:00:00Z" },
      { title: "Software Engineer Intern, C++ or Python – Summer", lastSeenAt: "2026-08-01T00:00:00Z" },
      { title: "Quant Researcher", lastSeenAt: "2026-09-01T00:00:00Z" },
    ]),
    "Software Engineer Intern, C++ or Python – Summer",
  );
  assert.equal(displayTitle("Hardware Engineer Winter Co Op", []), "Hardware Engineer Winter Co-op");
});

test("accents already present are kept by every rule", () => {
  assert.equal(tidyTitle("stagiaire en développement"), "Stagiaire en Développement");
  assert.equal(displayPlace("montréal qc"), "Montréal, QC");
  assert.equal(displayPlace("zürich switzerland"), "Zürich, Switzerland");
});

test("places are proper-cased, with codes in capitals and a comma before the region", () => {
  assert.equal(displayPlace("canada"), "Canada");
  assert.equal(displayPlace("new york ny"), "New York, NY");
  assert.equal(displayPlace("chicago il"), "Chicago, IL");
  assert.equal(displayPlace("san diego california"), "San Diego, California");
  assert.equal(displayPlace("london united kingdom"), "London, United Kingdom");
  assert.equal(displayPlace("seoul south korea"), "Seoul, South Korea");
  assert.equal(displayPlace("lincolnton nc us"), "Lincolnton, NC, US");
  assert.equal(displayPlace("washington d c"), "Washington, D.C.");
  assert.equal(displayPlace("san francisco"), "San Francisco");
  assert.equal(displayPlace("unspecified"), "Location not stated");
});
