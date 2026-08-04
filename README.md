# Auto Cards — découverte automatique pour Home Assistant

Série de cartes Lovelace qui se configurent seules : pas d'entités à saisir,
la carte découvre automatiquement les capteurs par `device_class` et les
regroupe par pièce.

## Cartes

| Carte | Domaine | Description |
|---|---|---|
| **Comfort Card** | `comfort-card` | Température + humidité par pièce, verdict de confort, KPI intérieur/extérieur |

## Installation (HACS)

1. HACS → ⋮ → Custom repositories
2. Ajouter le repo en catégorie **Dashboard**
3. Installer **Auto Cards**
4. Ajouter une carte `custom:comfort-card` à votre dashboard

## Configuration

```yaml
type: custom:comfort-card
name: Confort par pièce
```

Aucune entité à configurer — la carte découvre automatiquement les capteurs
`temperature` et `humidity` affectés à une pièce.

### Options

| Option | Défaut | Description |
|---|---|---|
| `name` | `Confort par pièce` | Titre de la carte |
| `exclude` | `['ballon','weather',...]` | Motifs à exclure (entity_id + nom) |
| `include` | `[]` | Entités forcées |
| `areas` | `null` | Restreindre à certaines pièces |
| `show_unassigned` | `false` | Afficher les capteurs sans pièce |
| `multiple` | `average` | `average` / `first` —多个 capteurs par pièce |
| `max_rows` | `0` | Limite de lignes (0 = illimité) |
| `sort` | `discomfort` | `discomfort` / `name` / `temperature` / `humidity` |
| `outdoor` | `null` | Entité weather (auto si null) |
| `temp_low` | `17` | Seuil bas température |
| `temp_high` | `26` | Seuil haut température |
| `humidity_low` | `35` | Seuil bas humidité |
| `humidity_high` | `60` | Seuil haut humidité |
| `humidity_very_high` | `70` | Seuil très haute humidité |