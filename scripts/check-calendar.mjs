import process from "node:process";
import { nyseCalendar } from "../server/analytics/data/nyseCalendar.js";
import { createExchangeCalendar } from "../server/analytics/data/exchangeCalendar.js";

const EXPECTED_REVISION = "sha256:a60c3ca84e5721ec8072af36137dfef8948951f6068f7fe824feedfcb600c7a3";

const EXPECTED_HOLIDAYS = Object.freeze({
  1997: ["1997-01-01", "1997-02-17", "1997-03-28", "1997-05-26", "1997-07-04", "1997-09-01", "1997-11-27", "1997-12-25"],
  1998: ["1998-01-01", "1998-01-19", "1998-02-16", "1998-04-10", "1998-05-25", "1998-07-03", "1998-09-07", "1998-11-26", "1998-12-25"],
  2021: ["2021-01-01", "2021-01-18", "2021-02-15", "2021-04-02", "2021-05-31", "2021-07-05", "2021-09-06", "2021-11-25", "2021-12-24"],
  2022: ["2022-01-17", "2022-02-21", "2022-04-15", "2022-05-30", "2022-06-20", "2022-07-04", "2022-09-05", "2022-11-24", "2022-12-26"],
  2025: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25"],
  2026: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
  2028: ["2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25"],
});

const EXPECTED_SESSION_COUNTS = Object.freeze({
  2021: 252,
  2022: 251,
  2023: 250,
  2024: 252,
  2025: 250,
  2026: 251,
});

const failures = [];

if (nyseCalendar.revision !== EXPECTED_REVISION) {
  failures.push(
    `The calendar definition changed. Revision is ${nyseCalendar.revision}, expected ${EXPECTED_REVISION}. `
    + "Confirm the rules are right, then update EXPECTED_REVISION in this script.",
  );
}

for (const [year, expected] of Object.entries(EXPECTED_HOLIDAYS)) {
  const generated = [...nyseCalendar.holidaysIn(Number(year)).keys()].sort();
  if (generated.join(" ") !== expected.join(" ")) {
    failures.push(`Holidays for ${year}\n  expected ${expected.join(" ")}\n  generated ${generated.join(" ")}`);
  }
}

for (const [year, expected] of Object.entries(EXPECTED_SESSION_COUNTS)) {
  const count = nyseCalendar.sessionDatesBetween(`${year}-01-01`, `${year}-12-31`).length;
  if (count !== expected) failures.push(`${year} has ${count} sessions, expected ${expected}`);
}

const adHoc = nyseCalendar.adHocClosures.map(({ date }) => date);
if (adHoc.join(" ") !== [...adHoc].sort().join(" ")) {
  failures.push("adHocClosures must stay in ascending date order");
}
for (const closure of nyseCalendar.adHocClosures) {
  if (nyseCalendar.isSession(closure.date)) {
    failures.push(`${closure.date} is listed as an unscheduled closure but still generates a session`);
  }
}

const EXPECTED_EARLY_CLOSES = Object.freeze({
  2024: ["2024-07-03", "2024-11-29", "2024-12-24"],
  2025: ["2025-07-03", "2025-11-28", "2025-12-24"],
  2026: ["2026-11-27", "2026-12-24"],
  2027: ["2027-11-26"],
});

for (const [year, expected] of Object.entries(EXPECTED_EARLY_CLOSES)) {
  const generated = nyseCalendar.earlyClosesBetween(`${year}-01-01`, `${year}-12-31`)
    .map(({ sessionDate }) => sessionDate);
  if (generated.join(" ") !== expected.join(" ")) {
    failures.push(`Early closes for ${year}\n  expected ${expected.join(" ")}\n  generated ${generated.join(" ")}`);
  }
}

try {
  nyseCalendar.sessionDatesBetween("1969-01-01", "1969-12-31");
  failures.push("The calendar answered for 1969, which its rules were never checked against");
} catch (error) {
  if (!(error instanceof RangeError)) failures.push(`Refusing an undescribed year raised ${error.name}`);
}

const sundayThursday = createExchangeCalendar({
  calendarId: "GENERALITY_PROBE",
  timeZone: "Asia/Jerusalem",
  source: "probe",
  marketWeekdays: [0, 1, 2, 3, 4],
  holidayRules: [{ name: "Probe", kind: "fixedDate", month: 5, day: 14, observance: "none" }],
});
const probeWeek = sundayThursday.sessionDatesBetween("2026-03-01", "2026-03-07");
if (probeWeek.join(" ") !== "2026-03-01 2026-03-02 2026-03-03 2026-03-04 2026-03-05") {
  failures.push(`A Sunday-to-Thursday market produced ${probeWeek.join(" ")}`);
}

if (failures.length) {
  console.error("Session calendar guardrail failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `Session calendar guardrail passed (${nyseCalendar.calendarId} at ${nyseCalendar.revision}, `
  + `${Object.keys(EXPECTED_HOLIDAYS).length} pinned years, ${nyseCalendar.adHocClosures.length} unscheduled closures).`,
);
