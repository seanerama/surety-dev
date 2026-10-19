The architecture is corrected and approved (architecture version 3), and the interface inventory is refreshed. Your saved design (revision e924801) is the starting point; keep everything in it, including my earlier feedback and the proposed logo, which stays proposed for the held-logo sequence.

Please make only these updates so the design matches the refreshed inventory, then save:
1. In screens.json, remove `page` and `design_tokens` from the web Plant list's interfaces, and `api_base_url` and `simulation` from the android Plant list's, together with the four `ok` states mapped to them. They are files of the UI modules now, not interfaces. Keep every list_plants, log_watering and INTERNET permission state as it is.
2. Bring design.json's inventory digest up to the refreshed inventory, and drop anything else that refers to those four interfaces (their fixtures included, if the design references them).
3. The logo: both targets use the logo slot's `on_dark` variant, web at public/assets/logo.svg and android at android/assets/logo.png (a PNG derived from on_dark), as your criteria already say. No change needed there unless the check says otherwise.

Tell me what the design check says after the save.
