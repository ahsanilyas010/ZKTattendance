# Runbook

## Go-live checklist for a new terminal

1. **Terminal network:** give it a fixed IP; note the IP and port (4370). Set its date, time and time zone correctly.
2. **Dashboard → Settings:** site time zone, SMTP details, send a test email.
3. **Dashboard → Devices & sync:** add the terminal; create the agent key; install the agent ([AGENT-SETUP](AGENT-SETUP.md)).
4. **Test connection** shows the model and serial. If not, see *Troubleshooting*.
5. **Import people** to pull names and IDs from the terminal, then open **Employees** and fix departments, shifts and join dates.
6. **Shifts:** edit the default shift (start, end, grace, absent-after, working days). Add others, e.g. an overnight shift, and assign people to them on the Employees page.
7. **Holidays** (Settings) and **leave** (employee → Leave) for known days off.
8. **Alerts:** create rules (late by N minutes, no punch N minutes after start, terminal offline, agent offline, end-of-day summary). Use **Send test email** on each.
9. **Reports → Scheduled:** add the weekly/monthly export and use **Send now** once.
10. Scan a face. Confirm it appears in **Punch log** with the right name, and on **Today**.

## Day to day

| I want to… | Where |
|---|---|
| Add a person | Employees → Add employee. Enter the ID they use on the terminal. Tick *write to the terminal* only if they are not already on it. |
| Someone left | Edit → Status: Inactive. History is kept; they no longer count as absent. |
| Fix a wrong ID | Edit the employee. Their earlier punches and reports are recalculated. |
| Unknown ID in the Punch log | Click *Assign to employee*. Earlier punches by that ID now show the name. |
| Change grace or hours | Devices & sync → Shift schedules. The last 60 days are recalculated automatically. |
| Change who gets alerts | Alerts → pick the rule → edit recipients → Save. |
| Get a payroll sheet | Reports → set range → *Daily summary* → Export. Hours are decimal (8.50 = 8h30). |

## How the numbers are worked out

* **Duplicates:** scans within the ignore window (default 120 s, Settings) of the previous counted scan are ignored. Raw punches are never edited or deleted.
* **First in / last out:** earliest and latest counted scan of the working day. One scan only → *Single punch*, no hours. Today's in/out labels in the Punch log are by order (1st In, 2nd Out, …).
* **Late:** first scan later than shift start + grace. Minutes late count from the start time.
* **Left early:** last scan earlier than shift end − grace, judged only after the shift has ended.
* **Absent:** no scan by *Absent after* minutes past the start, on a working day, and not on leave, a holiday, inactive or before the join date.
* **Overnight shifts:** scans before shift end + 4 h after midnight belong to the previous day.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Sidebar says *Agent offline* | Site PC is off, lost power, or has no internet. Punches are safe on the terminal and in the PC's queue; they upload when it returns. Check the log (`C:\zkagent\data\agent.log` or `journalctl -u zkagent`). |
| Device *Offline* but agent online | The PC cannot reach the terminal: wrong or changed IP, terminal off, cable/switch. From the PC: `ping <ip>`. Port 4370 must be open on the LAN. |
| *The cloud rejected the agent key* | Key regenerated or mistyped. Create a new key in the dashboard and update `agent.toml`, then restart the agent. |
| Punches missing for one terminal | Terminal clock wrong (dashboard warns when off by 2+ min). The agent ignores records dated before 2015 or more than a day ahead. |
| Hours look wrong | Check the time zone in Settings and the employee's shift. Overnight shifts need *End* earlier than *Start*. |
| Names show as *Unknown ID* | The ID is on the terminal but not in the Employee directory. Use *Import people* or *Assign to employee*. |
| No alert emails | Settings → Send test email. A rule's *Last sent* line shows the last send error. Check the 5-minute scheduler: `select * from cron.job_run_details order by start_time desc limit 5;`. |
| Absent shows for a day off | Add leave or a holiday. |

## Adding more terminals and sites

* **Another terminal on the same LAN/PC:** Devices & sync → Add device. The existing agent picks it up on its next cycle.
* **Another location with its own PC:** install the agent there with its own key (*Add another site agent*), then add its terminal. Data model, agent keys and punches are already per site.
* **Known limitation:** the dashboard manages one site (the first). A second location in a *different time zone* needs a site switcher in the UI. The schema and agent API already support it.
