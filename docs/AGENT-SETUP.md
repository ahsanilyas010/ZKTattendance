# Installing the agent on the site PC

The agent only needs two things: to reach the terminal on the local network (port 4370) and to make
outbound HTTPS requests to your dashboard. No inbound firewall rules, no changes to the terminal.

## Before you start

1. In the dashboard open **Devices & sync**.
2. Add the terminal (name, IP address, port 4370). The IP is under *Comm → Ethernet* on the terminal itself.
   Give the terminal a fixed IP (static or a DHCP reservation on the router) so it does not change.
3. Under **Local agent** click **Create agent key**. Copy the two lines it shows. The key is shown once.

## Windows

1. Install Python 3.10 or newer from python.org, ticking **Add python.exe to PATH**.
2. Copy the `agent` folder to the PC. Copy `agent.toml.example` to `agent.toml` and paste the two lines from the dashboard.
3. Open PowerShell **as administrator** in that folder and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install\windows\install-service.ps1
   ```

It checks the cloud connection and the terminal first and stops with a plain message if something is wrong.
On success it installs a scheduled task that starts with Windows and restarts the agent if it stops.
Log file: `C:\zkagent\data\agent.log`.

## Linux

```bash
cd agent && cp agent.toml.example agent.toml   # fill in the two values
sudo ./install/linux/install.sh
journalctl -u zkagent -f
```

## Check it works

* The sidebar of the dashboard shows **Agent online** within a minute.
* **Devices & sync → Test connection** reports the terminal model, serial and number of people enrolled.
* **Devices & sync → Import people** copies the names and ID numbers already on the terminal into the Employee directory.
* Scan a face or finger: the punch appears in **Punch log** within the polling interval (30 s by default).

You can run `zkagent check -c agent.toml` any time for a step-by-step diagnosis.

## Behaviour worth knowing

* **History:** on first connection it imports the last 90 days from the terminal (`initial_backfill_days`, 0 = everything).
* **Internet down:** punches keep being read from the terminal and wait in `queue.db`; they upload in order when the connection returns. `Waiting to upload` on the Devices page shows the backlog.
* **Terminal unreachable:** reported after two failed polls, which can trigger the *Device offline* alert.
* **Terminal clock:** the agent never changes it. If it is more than two minutes off, the dashboard says so; correct it on the terminal.
* **Never deletes** anything from the terminal. It only writes when you tick *Also write this name and ID to the terminal*.
* **Polling cost:** each poll reads the terminal's full log. With very large logs (tens of thousands of records) use a longer interval.

## Updating or removing

Update: copy the new `agent` folder over the old one and rerun the install script (your queue and settings are kept).
Windows removal: `Unregister-ScheduledTask ZKAttendanceAgent -Confirm:$false` and delete `C:\zkagent`.
Linux removal: `sudo systemctl disable --now zkagent && sudo rm -r /opt/zkagent /etc/systemd/system/zkagent.service`.

## Not verified yet

The Linux/Windows install scripts and the live conversation with a real terminal have not been run in
the environment this was written in. Run `zkagent check` first and report anything unexpected.
