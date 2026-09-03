# Prompt vs Flavor Text Audit

> **Historical.** This compares the flavor text against the original mechanic-derived prompts, which have since been replaced. The decision it was written to inform — hybrid: flavor scene with the mechanic as mood — was taken and implemented in `tools/rewrite-prompts-hybrid.mjs`. See [card-art-pipeline.md](card-art-pipeline.md).


The art prompts in `data/cards.json` were authored from each card's **`mechanics.kind`** — what the card *does*.
The `flavor` field describes the illustration printed in the **hardcopy book** — what the card *shows*.
These were never reconciled, so the generated art depicts game effects rather than the printed scenes.

Of 66 cards: **30 conflict**, **26 partial**, **10 agree**.

This is a decision, not just a bug — see *Which source wins* at the end.

## Conflict — 30 cards

The prompt depicts something else entirely. The flavor subject is absent from the art.

| Card | Flavor says (the printed illustration) | Prompt asks for | Mechanic |
|---|---|---|---|
| **Aberration** | A beholder hovers in a cluttered laboratory. The Aberration card embodies things contrary to nature. | A humanoid figure with alien eyes — too many, in wrong places — telepathic waves rendered as visible ripples emanatin… | `grant_telepathy` |
| **Bridge** | A stone bridge arcs across a waterway. A shadowy figure lurks under the bridge, only its gleaming eyes clearly visibl… | A figure standing perfectly still at the center of a frozen tableau — every other person around them locked motionles… | `cast_time_stop_n` |
| **Cavern** | A vast cavern is adorned with glowing fungi and striking stone formations. The Cavern card suggests exploration and d… | A figure climbing a sheer stone wall with bare hands and feet, grip natural and certain, the stone welcoming them as … | `climb_speed` |
| **Celestial** | A beautiful couatl twines through the clouds. This card suggests the involvement of celestial beings and service to t… | A figure with large white feathered wings fully extended, rising upward on a column of dawn light, the wings luminous… | `flight` |
| **Construct** | A modron wields a wrench in the interior of a vast clockwork machine. This card signifies things made by hand, includ… | A formal portrait of a small homunculus creature standing at the exact center of an ornate golden frame, mismatched c… | `spawn_homunculus` |
| **Corpse** | An adventurer lies dead in a dungeon hallway, pierced by arrows. The Corpse card embodies decay and corruption. | A figure falling backward, eyes closing, not in battle but simply dropping — sudden unconsciousness with no visible c… | `drop_to_zero_hp` |
| **Donjon** | Underground stairs lead to a heavy door made of iron bars. This card represents both imprisonment and freedom. | A solitary tower of black iron suspended in an empty grey void, no ground below it, no sky above, a single barred win… | `trap_extraplanar` |
| **Dragon** | A menacing red dragon perches atop its treasure hoard inside a cave. This card can point to things connected to Drago… | A newly hatched dragon wyrmling breaking free of a cracked egg, scales gleaming, tiny wings spread for the first time… | `spawn_wyrmling` |
| **Elemental** | A hungry xorn feeds in an Underdark cavern. This card suggests an Elemental creature or reducing a thing to its essen… | A figure at the center of a convergence of all five elemental forces — fire, ice, lightning, acid, thunder rendered a… | `element_immunity` |
| **Expert** | A bard plays a musical instrument. This card implies expertise, rightly or wrongly applied. | A figure in mid-motion blur — reflexes visible as afterimages, hands already positioned before a threat arrives, the … | `stat_bump` |
| **Fey** | A blink dog runs through the wild. When upright, this card can refer to a Fey creature or a sense of whimsy; reversed… | A shimmering archway of twisted silver-bark trees opening into the Feywild beyond — impossible saturated color, float… | `feywild_transport` |
| **Fiend** | A balor strikes from the depths of the Abyss. This card alludes to an actual Fiend or the forces of the Lower Planes. | A composed fiend in ornate dark clothing seated across a table from an unseen figure, a contract of glowing red scrip… | `fiend_deal` |
| **Fool** | A person walks down a path, unwittingly dropping items along the way. The Fool card represents innocence. | A court jester mid-tumble over a cliff edge, bells on his cap still ringing, his expression frozen between laughter a… | `xp_loss` |
| **Giant** | A hungry troll lurks in a forest clearing. The Giant card indicates something very large or that looms large in one's… | A figure visibly taller than they were — the frame too small to contain them now, the ceiling brushing their head, th… | `size_grow` |
| **Humanoid** | Kobolds set a trap in their cave lair. This card points to the importance of empathy in relationships with other peop… | A figure standing at a crossroads with multiple glowing card-paths stretching outward, one hand raised palm-forward i… | `stop_drawing_optional` |
| **Lance** | An ornate dragonlance shines among more ordinary weapons on a rack. The Lance card warns that healing sometimes requi… | A full-body figure with every limb and feature outlined in faint golden enhancement-light, each ability score shown a… | `all_stats_bump` |
| **Mage** | A warlock holds a black crystalline staff. This card suggests both mental acuity and arcane magic. | A scholar surrounded by floating equations and arcane diagrams that have suddenly snapped into perfect clarity, the f… | `stat_bump` |
| **Monstrosity** | An owlbear sits in a sunny glade. This card represents something monstrous, including familiar things that turn stran… | A massive creature of nightmare proportions tearing through a rift in reality, hostile and immediate, its attention f… | `spawn_hostile` |
| **Plant** | A myconid emits a cloud of spores. The Plant card reflects growth and natural life. | A figure kneeling with both hands pressed to the soil, plants and roots responding — bending toward them, communicati… | `spellcast_slotless` |
| **Priest** | A cleric holds a heavy mace. The Priest card represents wisdom, insight, closeness to the divine, and divine magic. | A figure in meditation, eyes closed, the sapflow-light of divine connection visible as golden currents flowing throug… | `stat_bump` |
| **Prisoner** | A rogue begs for release from a dank prison cell. The Prisoner card represents someone or something locked and hidden… | A figure wrapped in invisible force — the air around them warped and shimmering with magical restraint, wrists bound … | `restrain_no_spellcast` |
| **Puzzle** | An elaborate puzzle box floats in the air, glowing from within. The Puzzle card speaks to intelligence and strategic … | A human head in profile, the skull open at the top, puzzle pieces inside scattering outward and floating away in diff… | `stat_debuff` |
| **Ruin** | An elegant sword and crown disintegrate into eddies of ash. The Ruin card warns of the inevitability of decay and the… | A grand estate crumbling at the moment of collapse, coins and papers flying in every direction, treasure chests burst… | `wealth_wipe` |
| **Shield** | A circular shield is close at hand in a military barrack. The Shield card is a reminder of the need for protection. | A suit of armor assembling itself around a figure piece by piece without hands to place it, each piece glowing briefl… | `armor_grant` |
| **Statue** | A statue depicts the god Istus offering the original Deck of Many Things as a gift. The Statue card is a reminder of … | A figure frozen mid-gesture as grey marble stone creeps from their feet upward, the face still wearing the last human… | `petrify` |
| **Tomb** | A burial chamber holds a plain stone casket. The Tomb card suggests buried secrets and things long forgotten. | A figure at a grave, hands extended, light flowing from their palms into the earth — the dead responding, rising in s… | `resurrection_grant` |
| **Tower** | A tall, ornate tower made of black stone looms over a desolate landscape. The Tower card represents isolation. | Two glowing cards hanging suspended side by side — one bright, one shadowed — a hand reaching toward them, choosing; … | `draw_two_keep_one` |
| **Tree** | A tree has broken through a fortress wall and reclaimed part of the keep. This card suggests perseverance in difficul… | A figure whose skin is becoming bark in real time — grey-brown textured plates spreading across their arms, their sil… | `unarmored_defense` |
| **Void** | An endless void seems to spiral toward a central hole that devours all. This card spells disaster. | A body standing hollow and empty, the chest a literal window of darkness through which stars are visible, no soul pre… | `soul_trap` |
| **Warrior** | A barbarian holds a greataxe. The Warrior card embodies physical strength and fighting acumen. | A figure lifting something heavier than they should be able to, the effort visible but less than expected — new stren… | `stat_bump` |

## Partial — 26 cards

Right subject, wrong scene — the card's object or character is present but the situation differs.

| Card | Flavor says (the printed illustration) | Prompt asks for | Mechanic |
|---|---|---|---|
| **Beast** | The Beast card points to creatures of the animal kingdom and foul, cruel, or bad-tempered behavior in people. | A human figure mid-transformation into a large animal, the body caught between forms, clothing tearing as limbs resha… | `beast_form` |
| **Crossroads** | A signpost points in many directions at a crossroads. The Crossroads cards warns of a difficult but necessary decisio… | An hourglass at a literal crossroads, time flowing in both directions simultaneously — upward and downward — a figure… | `age_shift` |
| **Door** | A large wooden door bars the path ahead. The Door card offers an opportunity to change. | An ornate arched doorway standing freestanding in empty space, through its frame a swirling portal to elsewhere — ano… | `cast_gate_n` |
| **Euryale** | A female medusa with a serpentine tail instead of legs is surrounded by flowers and herbs. The Euryale card points to… | A female figure with writhing serpents for hair, her gaze averted to spare the viewer, her expression not monstrous b… | `save_penalty` |
| **Flames** | A chain devil, wreathed in flames, looks menacing and angry. The Flames card brings enemies and vengeance. | A horned devil figure cloaked in dark robes and hellfire, staring directly at the viewer with eyes of cold amber inte… | `permanent_enemy` |
| **Gem** | A large, faceted gemstone set in intricate filigree gleams invitingly. The Gem card brings vast wealth. | A cascade of luminous jewels and ornate jewelry pieces tumbling through dark air, each gem catching interior light — … | `wealth_grant` |
| **Jester** | A person wearing jester's motley and holding a staff rests his foot on a skull. This card deals with the relationship… | A grinning jester holding a forking road in one hand — two paths made literal as tiny glowing lines — and a sheaf of … | `bonus_draws` |
| **Knight** | A knight formed of folded cards offers a sword also made from cards. The Knight card signifies trust and loyalty. | A fully armored knight in gleaming silver plate kneeling in a posture of sworn fealty, sword point-down before them, … | `spawn_ally_npc` |
| **Mine** | A well-crafted pick leans against a wall at the entrance to a mine. The Mine card represents something valuable under… | An underground vein of brilliant gemstones cracking open in real time, jewels of every color tumbling outward from th… | `wealth_grant` |
| **Moon** | A crescent moon looms large in the autumn sky. The Moon card points to hidden potential. | A vast full moon dominating the night sky, its face expressionless but watching, three luminous spheres orbiting it l… | `wish` |
| **Ooze** | A gelatinous cube with various items suspended inside it creeps through a vaulted sewer. The Ooze card indicates the … | A translucent gelatinous mass already surrounding a figure from all sides, the figure visible as a silhouette inside … | `spawn_ooze` |
| **Path** | A well-worn path twists through the wilderness, with hidden dangers lurking in the shadows to both sides. This card s… | A golden road stretching to the horizon, visibly shorter than it used to be — distances compressed by permanent swift… | `speed_bonus` |
| **Pit** | A deep hole studded with spikes gapes in the earth. The Pit card represents a literal or metaphorical fall—losing sta… | A figure in freefall through empty air, the stone floor that was there one moment simply gone, the drop below them va… | `fall` |
| **Ring** | An emerald ring glows within a decorative jewelry box. The Ring card suggests both a promise and the honor involved i… | A single ornate ring descending from above onto an outstretched finger, the ring glowing with contained magic, its se… | `ring_grant` |
| **Rogue** | A roguish kenku lurking in the shadows holds a dagger, poised to strike. This card suggests treachery and deception. | A shadowed figure standing very close behind someone who does not know they are there, one gloved hand reaching towar… | `random_hostile_npc` |
| **Sage** | The mind of a sage is filled with obscure lore gained through exhaustive research. This card represents well-intentio… | An ancient scholar seated before a single floating orb of absolute white light — the answer to any question compresse… | `sage_query` |
| **Ship** | A three-masted ship with a couatl figurehead sails across the open sea. The Ship card indicates a long journey, not n… | A figure at a ship's wheel in a storm, impossibly confident, every rope and sail obeying without thought — seamanship… | `skill_proficiencies` |
| **Staff** | An elegant black staff leans against a wall, waiting for its owner to return. The Staff card represents support or as… | An ornate magical staff, rod, or wand floating vertically at center, thrumming with visible stored power — arcane run… | `rod_or_staff_grant` |
| **Stairway** | A spiral stairway leads both up and down, but the downward stairs are cluttered and dark. This card points to a chang… | A stone staircase descending rather than ascending, a warm light at the bottom suggesting safety — the wise path goin… | `wondrous_grant` |
| **Star** | A brilliant star shines in the spring sky at twilight. The Star card represents inherent ability and training working… | A human silhouette dissolving upward into a field of stars, the figure's outline becoming indistinguishable from cons… | `stat_bump` |
| **Talons** | A clawed hand reaches to grab an emerald ring, which disintegrates at the claw's approach. The Talons card indicates … | Enormous dark claws of pure void energy shredding through a collection of glowing magical items, artifacts dissolving… | `destroy_magic_items` |
| **Tavern** | An adventuring party eats and laughs in a busy tavern. The Tavern card points to the pleasure of spending time with f… | A warm tavern common room, a charismatic figure at its center around whom the whole room naturally orients — conversa… | `stat_bump` |
| **Temple** | A temple invites worshipers into the serene space within. The Temple card suggests the comfort found in ritual and co… | A vast divine eye opening above a temple, its gaze turning to fall on a single small figure below — the full weight o… | `resurrection_grant` |
| **Throne** | An ostentatious throne stands on a dais, with a crown on the seat and a ceremonial sword leaning against one armrest.… | An ornate stone throne in a great hall, the seat glowing with subtle charisma-light, a rolled deed and a lord's seal … | `throne_persuasion` |
| **Undead** | A lich beckons souls of the dead. This card can point to anything that refuses to die, from old grudges and unresolve… | A revenant rising from a grave, its gaze already fixed on a distant point — hunting, purposeful, the eyes burning wit… | `revenant_hunter` |
| **Well** | A stone well stands in a peaceful meadow, surrounded by wildflowers. The Well card speaks of drawing resources from f… | A stone well at night, moonlight falling into it revealing the water far below alive with magical light, a figure lea… | `three_cantrips` |

## Agree — 10 cards

Prompt and flavor describe substantially the same image. No action needed.

| Card | Flavor says (the printed illustration) | Prompt asks for | Mechanic |
|---|---|---|---|
| **Balance** | A set of scales holds day and night in balance. This card deals with many aspects of balance, or with things being ou… | A set of ornate golden scales perfectly balanced, each pan holding abstract glowing symbols representing opposing mor… | `alignment_flip` |
| **Book** | An enormous book rests among scrolls and parchment, with a quill and ink nearby. The Book card embodies written infor… | A large open tome radiating dozens of glowing scripts simultaneously — elvish, draconic, celestial, ancient sigil-lan… | `learn_languages` |
| **Campfire** | A large campfire offers safety and comfort in the night. This card suggests a need for rest. | A warm campfire burning cheerfully in the center of the card, deep night around it, a bedroll and pack visible at the… | `long_rest` |
| **Comet** | A comet with an enormous tail streaks across the winter sky at night, outshining the stars. The Comet card brings dir… | A blazing comet of pure white-gold light arcing across a deep indigo night sky, its tail fragmenting into smaller mot… | `solo_kill_level_up` |
| **Fates** | Three sisters weave, measure, and cut the threads of fate. This card explores the repercussions of decisions and refl… | Three robed women at a cosmic loom, threads of gold light stretched between their fingers, one thread visibly severed… | `erase_event` |
| **Key** | This large metal key is bizarrely complicated. The Key card represents the perfect solution to a problem or having th… | An ornate skeletal key of antique gold hovering point-down in empty space, glowing softly with amber inner light, its… | `magic_weapon_grant` |
| **Map** | X marks the spot on an elaborate treasure map. The Map card provides guidance that leads to the goal of the quest. | An ancient map unfurling in empty space, one location burning with golden light while the rest fades — the single poi… | `map_query` |
| **Maze** | Unfortunate souls are trapped in an elaborate and impossible maze of cards. Those who draw the Maze card are lost. | An overhead view of an impossible labyrinth with no exit, a tiny figure at its center looking up with exhausted eyes,… | `exhaustion` |
| **Skull** | A skeletal figure is shrouded in a swirling robe, though its skull is clearly visible. The Skull card is a reminder o… | A skeletal avatar of death in dark flowing robes, scythe raised and gleaming with silver-black finality, standing in … | `avatar_of_death` |
| **Sun** | A sun blazes brightly in the summer sky. The Sun card brings hope—either well-founded or deluded. | A blinding solar disc at center, rays of pure gold light flooding the entire card frame, a small figure at the bottom… | `xp_gain` |

## Which source wins

Both are defensible and the choice is yours:

- **Follow the flavor text** — the art matches the physical deck players may own, and sits
  consistently beside the divination meanings transcribed from the same book. Costs a rewrite
  of ~56 prompts.
- **Follow the mechanics** — the art tells a player what the card *does* the moment it is drawn,
  which arguably serves a VTT better than reproducing a book illustration. Costs nothing; the
  current prompts already do this.
- **Hybrid** — flavor subject as the scene, mechanic as the mood or a secondary detail. Best
  result, most authoring effort.

The 10 cards under *Agree* land in the same place either way, so they need no change whichever
direction you pick.
