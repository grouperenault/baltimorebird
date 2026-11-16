---
type: Roadmap
title: Reporting par analyses génériques
description: Écrire une analyse une fois, l'exécuter sur les données choisies, lire un rapport qui dit quelle analyse et quels fichiers l'ont produit.
tags: [reporting, dashboard, analyses, dictionnaire, provenance]
status: draft
generated:
  by: claude/opus-5.5
  at: 2026-11-15T00:00:00Z
---

# Reporting par analyses génériques

Prospectif. La tranche 1 est implémentée (voir plus bas) ; le reste ne l'est
pas. L'existant avant ce chantier est décrit dans
[Dashboard Builder](/architecture/dashboard-builder.md).

## L'intention

Aujourd'hui une recette porte ses propres données (source synthétique) : elle
produit toujours le même rapport. La cible sépare trois temps :

1. **Analyse.** On écrit une fois une analyse générique, par exemple « Haute
   tension », sans y attacher de données. Elle déclare les signaux dont elle a
   besoin.
2. **Exécution.** On choisit l'analyse, puis les données d'entrée, et on lance.
   La même analyse sert sur n'importe quels fichiers, aussi souvent que
   nécessaire.
3. **Rapport.** Le résultat est conservé avec sa provenance : quelle analyse,
   dans quelle version, sur quels fichiers, avec quelle résolution des signaux.

La section Reporting suit ces trois temps : onglets **Analyses**, **Exécuter**,
**Rapports**. Chacun a une seule responsabilité :

| Onglet | Fait | Ne fait pas |
| --- | --- | --- |
| Analyses | écrire l'analyse : blocs, entrées déclarées, code généré | choisir des données, un mode, lancer |
| Exécuter | choisir l'analyse, les données et le mode ; file et console | modifier l'analyse |
| Rapports | lire un rapport et sa provenance ; relancer | produire un rapport |
 L'éditeur reste une liste ordonnée de blocs (un document lu de
haut en bas), pas un graphe à ports ; cet écart avec `EDT-02` et `EDT-07` fera
l'objet d'une décision au moment de l'implémentation.

## L'analyse déclare ses entrées

Un bloc **Entrées** remplace la source synthétique en tête de recette. Il
déclare des variables (`MAP-01`) : un nom de variable, le nom exact du signal
recherché et l'unité attendue. Le reste de la recette ne connaît que les noms
de variables, comme aujourd'hui.

Le **mode** se choisit à l'exécution, pas dans l'analyse : la même analyse
sert dans les deux.

- **par fichier** : une exécution, donc un rapport, par fichier sélectionné, en
  séquence ;
- **fusionné** : tous les fichiers alimentent une seule exécution et un seul
  rapport (statistiques de campagne, superposition).

## Le dictionnaire de signaux

La résolution d'un signal est **exacte**, et le dictionnaire la rend tolérante :

- chaque nom de signal utilisé par une analyse enregistrée entre dans le
  dictionnaire ;
- deux noms qui mesurent la même grandeur physique peuvent être liés comme
  **alias** (`BMS_HVBattVolt` et `HV_Voltage`). Seul un administrateur lie des
  alias : un alias faux fausse silencieusement tous les rapports qui
  l'empruntent ;
- à l'exécution, un signal introuvable sous son nom exact est cherché parmi ses
  alias. Utiliser l'un ou l'autre devient transparent.

C'est le dictionnaire applicatif que la spécification du PoC exclut (§3.2,
note du §8) : il entre ici dans le périmètre.

## D'où viennent les données

Pour l'instant, **données synthétiques uniquement**. Elles sont présentées
comme des jeux de données sélectionnables, au même titre que les futurs
fichiers, pour que l'écran d'exécution soit réel dès la première tranche.

Flux cible :

| Besoin | Source |
| --- | --- |
| Un fichier | Téléversement, API d'un fournisseur de données, ou accès direct au disque en [mode hors ligne](/roadmap/offline-first.md) |
| Plusieurs fichiers (par fichier ou fusionné) | Fournisseur de données, via la [chaîne de conversion Parquet](/roadmap/datalake-pipeline.md) ; fichiers Parquet locaux en mode hors ligne |

Le format Parquet visé est celui décrit dans
[Format Parquet ASAM Big ODS](/roadmap/parquet-asam-big-ods.md).

## Confinement inchangé

Le processus Flask extrait des fichiers **uniquement les signaux déclarés**,
avec les lecteurs existants, vers un répertoire propre à l'exécution. Le
processus fils confiné ne lit que ce répertoire : il ne voit ni l'espace de
stockage ni les chemins des fichiers d'origine. Voir
[Invariants de sécurité](/policies/security-invariants.md).

Une exécution par lot (mode par fichier) est un travail suivi entre plusieurs
requêtes. Son état vit en mémoire du worker unique, ce que permet
[le worker gunicorn unique](/decisions/0002-single-gunicorn-worker.md).

## Le rapport et sa provenance

Chaque rapport est conservé avec : analyse (identifiant, nom,
`provenance_hash`), fichiers d'entrée (nom, empreinte), résolution des signaux
(nom exact ou alias retenu), mode, état de l'exécution, durée, utilisateur,
date. Le visualiseur affiche cette provenance à côté du rapport et propose de
relancer l'analyse sur d'autres données.

Le rapport est affiché dans l'application, dans une origine opaque (en-tête
CSP `sandbox` sans `allow-same-origin`), sans accès aux cookies ni au stockage
de l'application. C'est l'interprétation retenue de `SEC-16`, qui demande une
origine distincte de celle de l'application : à confirmer.

## Tranches

1. **Les trois écrans, sur données synthétiques.** Onglets Analyses,
   Exécuter, Rapports ; bloc Entrées ; jeux synthétiques sélectionnables ;
   modes par fichier et fusionné ; rapports conservés avec leur provenance.
   *Implémentée.* Bloc `inputs` dans `services/dashboard/inputs.py`, catalogue
   dans `data/default/datasets/` lu par `services/dashboard/datasets.py`,
   routes `/api/reporting/*` dans `api/reporting.py`, rapports et provenance
   (fichier JSON voisin) dans `services/dashboard/report_store.py`. Les
   exécutions passent par une file (`services/dashboard/run_queue.py`) : un
   seul fil les traite une par une, en mémoire du worker ; l'onglet Exécuter
   suit la file et sa console. Une analyse en attente peut être retirée, une
   analyse en cours ne peut pas encore être interrompue (`LIF-01`), et la file
   est perdue au redémarrage du serveur. La source synthétique
   n'est plus proposée dans l'éditeur : l'analyse de démonstration
   (`script_analyse_standard`) déclare ses entrées, et ses données sont le
   seul jeu livré, `demo-synthetique`, choisi dans Exécuter. Le type
   `synthetic_source` reste compilé pour les analyses enregistrées avant.
2. **Dictionnaire et alias.** Alimentation à l'enregistrement d'une analyse,
   liaison d'alias, résolution à l'exécution, affichage de la résolution avant
   lancement.
3. **Un fichier réel.** Téléversement, API fournisseur, accès local.
4. **Plusieurs fichiers réels.** Parquet issu de la chaîne fournisseur ou local.

L'ergonomie de l'éditeur suit en parallèle, selon
[Dashboard Builder, ergonomie et chaîne d'exécution](/roadmap/dashboard-builder-ux.md).
Le défaut de sécurité ouvert listé dans
[la suite du Dashboard Builder](/roadmap/dashboard-builder-next.md) passe avant
l'arrivée de données réelles.

## Questions ouvertes

- Deux alias dans des unités différentes (V et kV) : conversion automatique ou
  refus ?
- Mode fusionné : la tranche 1 empile les jeux dans l'ordre de sélection, avec
  une colonne `source_index` (rang du jeu) et le temps propre à chaque jeu. À
  confirmer à l'usage, ou à remplacer par une table par fichier.
- Durée de conservation des rapports et des données extraites par exécution.
