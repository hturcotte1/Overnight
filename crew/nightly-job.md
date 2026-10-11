<!--
The message Overnight gives Kiro Crew for one build ("kirocrew cron add overnight-build-<idea id> <this message> ...").
packages/builder reads this file, drops this comment, joins the lines into one, and fills in:
  <BRIEF>      full path of brief.md
  <WORKSPACE>  full path of the workspace folder that holds it
  <SKILL>      full path of the installed skill file (the text of crew/build-skill.md)
Keep it short and keep it ours: no idea text ever goes in this message. The brief is the only
thing the agent is given about the idea.
-->
Read the brief at <BRIEF> and build the app it describes in the folder <WORKSPACE>, following the overnight-build skill.
The skill's full text is the file <SKILL> ; read it first if the skill is not already loaded.
Work only inside <WORKSPACE>.
