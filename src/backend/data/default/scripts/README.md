# Scripts - Dashboard Analysis

Ce dossier contient les définitions des scripts d'analyse créés via l'éditeur de blocs du Dashboard.

## Principe

Les scripts sont stockés sous forme de **définition de blocs** (JSON), et le code Python est **généré à la volée** lors de l'exécution. Cela évite la duplication et garantit que le code est toujours synchronisé avec la définition visuelle.

## Format des fichiers

Les scripts sont stockés au format JSON avec l'extension `.json`.

### Structure d'un script

```json
{
  "id": "script_analyse_standard",
  "name": "Analyse standard (démo complète)",
  "description": "Rapport de référence couvrant tous les types de blocs",
  "created": "2026-09-11T00:00:00Z",
  "modified": "2026-09-11T00:00:00Z",
  "blocks": [
    {
      "id": "block_inputs",
      "type": "inputs",
      "config": {
        "name": "df",
        "signals": "vehicle_speed km/h\nengine_rpm rpm"
      }
    },
    {
      "id": "block_sec",
      "type": "section",
      "config": { "title": "Dynamique véhicule", "level": 1 }
    },
    {
      "id": "block_plot",
      "type": "lineplot",
      "config": {
        "source": "df",
        "x": "time",
        "y": "vehicle_speed",
        "title": "Vitesse véhicule",
        "color": "#89b4fa",
        "unit": "km/h"
      }
    }
  ],
  "settings": {
    "title": "Analyse standard d'un essai de roulage",
    "author": "Baltimore Bird"
  },
  "lastRun": null,
  "lastRunStatus": null,
  "lastRunDuration": null
}
```

## Types de blocs supportés

Le catalogue fait foi : `services/dashboard/blocks.py` (`BLOCK_REGISTRY`). Chaque type ci-dessous,
sauf `synthetic_source`, est présent au moins une fois dans le script par défaut
`script_analyse_standard.json`, garanti par le test `test_default_standard_recipe_covers_every_block_type`.

Une analyse ne contient pas ses données : son bloc `inputs` déclare les signaux requis, et les
données sont choisies dans l'onglet Exécuter (jeux de `data/default/datasets/`), avec le mode :
un rapport par jeu (`per_file`) ou un rapport sur tous les jeux (`merged`). Le mode n'appartient
pas à l'analyse.

| Type | Catégorie | Description | Config |
|------|-----------|-------------|--------|
| `inputs` | data | Signaux requis, une ligne `nom [unité]` ; données choisies à l'exécution | `name`, `signals` |
| `synthetic_source` | data | Ancienne source intégrée à l'analyse, plus proposée dans l'éditeur ; compilée pour les analyses existantes | `name`, `samples`, `period`, `seed`, `signals[]` |
| `title` | layout | Page de titre du rapport | `title`, `subtitle`, `author` |
| `section` | layout | Titre de section | `title`, `level` (1/2/3) |
| `text` | layout | Paragraphe | `content` |
| `callout` | layout | Encadré info/success/warning/danger | `type`, `title`, `content` |
| `metrics` | viz | Cartes KPI, une ligne `label: expression` par métrique | `source`, `metrics` |
| `table` | viz | Tableau de données | `source`, `caption`, `max_rows` |
| `lineplot` | viz | Courbe temporelle | `source`, `x`, `y`, `title`, `color`, `unit` |
| `python` | code | Code Python utilisateur, validé par la liste blanche AST | `code`, `inputs[]`, `output` (`figure`/`table`) |

Les expressions des blocs `metrics` et le code des blocs `python` s'exécutent dans le module
généré : ils passent la même analyse statique (liste blanche AST) que n'importe quel code
utilisateur, puis le sous-processus confiné.

## Workflow d'exécution

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Script    │ ──▶ │  Generate   │ ──▶ │   Execute   │ ──▶ │   Report    │
│   (JSON)    │     │   Python    │     │   Script    │     │   (HTML)    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

1. **Load** - Charge la définition JSON du script
2. **Generate** - Génère le code Python à partir des blocs
3. **Execute** - Exécute le script avec les données
4. **Output** - Produit le rapport HTML

## API Endpoints

- `GET /api/scripts` - Liste tous les scripts
- `GET /api/scripts/{id}` - Récupère un script
- `POST /api/scripts` - Crée un nouveau script
- `PUT /api/scripts/{id}` - Met à jour un script
- `DELETE /api/scripts/{id}` - Supprime un script
- `POST /api/scripts/{id}/run` - Exécute un script
- `GET /api/scripts/{id}/preview` - Prévisualise le code Python généré