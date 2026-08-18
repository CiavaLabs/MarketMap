import { MOVEMENT_SESSION_CALENDAR_ID } from "../contracts/constants.js";
import { createExchangeCalendar } from "./exchangeCalendar.js";

export const NYSE_CALENDAR_SOURCE = "nyse_published_rules";

const HOLIDAY_RULES = Object.freeze([
  { name: "New Year's Day", kind: "fixedDate", month: 1, day: 1, observance: "sundayToMonday" },
  { name: "Martin Luther King Jr. Day", kind: "nthWeekday", month: 1, weekday: 1, nth: 3, effectiveFrom: 1998 },
  { name: "Washington's Birthday", kind: "nthWeekday", month: 2, weekday: 1, nth: 3 },
  { name: "Good Friday", kind: "relativeToEaster", offsetDays: -2 },
  { name: "Memorial Day", kind: "lastWeekday", month: 5, weekday: 1 },
  { name: "Juneteenth National Independence Day", kind: "fixedDate", month: 6, day: 19, observance: "nearestWeekday", effectiveFrom: 2022 },
  { name: "Independence Day", kind: "fixedDate", month: 7, day: 4, observance: "nearestWeekday" },
  { name: "Labor Day", kind: "nthWeekday", month: 9, weekday: 1, nth: 1 },
  { name: "Thanksgiving Day", kind: "nthWeekday", month: 11, weekday: 4, nth: 4 },
  { name: "Christmas Day", kind: "fixedDate", month: 12, day: 25, observance: "nearestWeekday" },
]);

const EARLY_CLOSE_RULES = Object.freeze([
  { name: "Day before Independence Day", kind: "fixedDate", month: 7, day: 3, observance: "none" },
  { name: "Day after Thanksgiving", kind: "nthWeekday", month: 11, weekday: 4, nth: 4, offsetDays: 1 },
  { name: "Christmas Eve", kind: "fixedDate", month: 12, day: 24, observance: "none" },
]);

const AD_HOC_CLOSURES = Object.freeze([
  { date: "1994-04-27", reason: "National day of mourning for Richard Nixon" },
  { date: "2001-09-11", reason: "September 11 attacks" },
  { date: "2001-09-12", reason: "September 11 attacks" },
  { date: "2001-09-13", reason: "September 11 attacks" },
  { date: "2001-09-14", reason: "September 11 attacks" },
  { date: "2004-06-11", reason: "National day of mourning for Ronald Reagan" },
  { date: "2007-01-02", reason: "National day of mourning for Gerald Ford" },
  { date: "2012-10-29", reason: "Hurricane Sandy" },
  { date: "2012-10-30", reason: "Hurricane Sandy" },
  { date: "2018-12-05", reason: "National day of mourning for George H. W. Bush" },
  { date: "2025-01-09", reason: "National day of mourning for Jimmy Carter" },
]);

export const NYSE_CALENDAR_DESCRIBED_FROM = "1993-02-01";

export const nyseCalendar = createExchangeCalendar({
  describedFrom: NYSE_CALENDAR_DESCRIBED_FROM,
  calendarId: MOVEMENT_SESSION_CALENDAR_ID,
  timeZone: "America/New_York",
  source: NYSE_CALENDAR_SOURCE,
  marketWeekdays: [1, 2, 3, 4, 5],
  holidayRules: HOLIDAY_RULES,
  earlyCloseRules: EARLY_CLOSE_RULES,
  adHocClosures: AD_HOC_CLOSURES,
});
