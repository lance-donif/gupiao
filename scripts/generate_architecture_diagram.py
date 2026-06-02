#!/usr/bin/env python3
"""
Auto-generate architecture diagrams from codebase structure.

This script:
1. Analyzes the codebase structure
2. Generates Mermaid.js diagrams for architecture visualization
3. Updates docs/architecture/overview.md

Usage:
    python scripts/generate_architecture_diagram.py [--output docs/architecture/overview.md]
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


def analyze_project_structure(root_dir: str) -> dict:
    """Analyze project directory structure."""
    structure = {
        "backend": {"modules": [], "layers": []},
        "web": {"components": [], "pages": [], "services": []},
    }

    root_path = Path(root_dir)

    # Analyze backend (TypeScript) structure
    backend_src = root_path / "backend" / "src"
    if backend_src.exists():
        structure["backend"]["layers"] = sorted(
            [item.name for item in backend_src.iterdir() if item.is_dir() and not item.name.startswith("_")]
        )
        # Modules: first-level non-index TS files (stable signal, not perfect).
        structure["backend"]["modules"] = sorted(
            [
                item.stem
                for item in backend_src.glob("*.ts")
                if item.is_file() and item.name not in {"index.ts"}
            ]
        )

    # Analyze web structure
    web_path = root_path / "web" / "src"
    if web_path.exists():
        for item in web_path.iterdir():
            if item.is_dir() and not item.name.startswith("_"):
                if item.name == "components":
                    structure["web"]["components"] = [f.stem for f in item.glob("*.vue")][:10]  # Limit to 10
                elif item.name == "pages":
                    structure["web"]["pages"] = [f.stem for f in item.glob("*.vue")][:10]
                elif item.name == "services":
                    structure["web"]["services"] = [f.stem for f in item.glob("*.ts") if f.stem != "__init__"]

    return structure


def generate_mermaid_architecture_diagram(structure: dict) -> str:
    """Generate Mermaid.js architecture diagram."""
    lines = []
    lines.append("```mermaid")
    lines.append("graph TB")
    lines.append("    subgraph Client[Frontend - Vue 3]")
    lines.append("        Web[Web Application]")
    lines.append("        Pages[Pages & Views]")
    lines.append("        Components[UI Components]")
    lines.append("        State[State Management]")
    lines.append("    end")
    lines.append("")
    lines.append("    subgraph API[Backend - TypeScript (HTTP shell)]")
    lines.append("        Shell[HTTP Shell]")
    lines.append("        Services[Services]")
    lines.append("        Runtime[Runtime Store]")
    lines.append("        DB[Database/Repositories]")
    lines.append("    end")
    lines.append("")
    lines.append("    subgraph Data[Data Layer]")
    lines.append("        Postgres[(PostgreSQL)]")
    lines.append("        Redis[(Redis)]")
    lines.append("    end")
    lines.append("")
    lines.append("    subgraph External[External Services]")
    lines.append("        LLM[LLM APIs]")
    lines.append("        Market[Market Data]")
    lines.append("        News[News Sources]")
    lines.append("    end")
    lines.append("")
    lines.append("    %% Frontend to Backend")
    lines.append("    Web -->|HTTP/JSON| Shell")
    lines.append("    Pages --> Components")
    lines.append("    Components --> State")
    lines.append("")
    lines.append("    %% Backend Internal")
    lines.append("    Shell --> Services")
    lines.append("    Services --> Runtime")
    lines.append("    Services --> DB")
    lines.append("")
    lines.append("    %% Data Layer")
    lines.append("    DB --> Postgres")
    lines.append("    DB --> Redis")
    lines.append("")
    lines.append("    %% External Services")
    lines.append("    Services -->|Fetch| Market")
    lines.append("    Services -->|Fetch| News")
    lines.append("    Services -->|LLM Calls| LLM")
    lines.append("```")

    return "\n".join(lines)


def generate_data_flow_diagram() -> str:
    """Generate Mermaid.js data flow diagram for Night/Morning flows."""
    lines = []
    lines.append("```mermaid")
    lines.append("sequenceDiagram")
    lines.append("    participant User")
    lines.append("    participant Shell as HTTP_Shell")
    lines.append("    participant Runner as Scheduler/Runner")
    lines.append("    participant DB")
    lines.append("    participant LLM")
    lines.append("")
    lines.append("    Note over User,Shell: Night Flow (Evening Analysis)")
    lines.append("    User->>Shell: POST /api/dispatch/daily")
    lines.append("    Shell->>Runner: Dispatch batch")
    lines.append("    Runner->>LLM: News analysis")
    lines.append("    Runner->>DB: Store results")
    lines.append("    Runner-->>Shell: Batch complete")
    lines.append("")
    lines.append("    Note over User,Shell: Morning Flow (Pre-Market)")
    lines.append("    User->>Shell: GET /api/batches/latest/:groupId")
    lines.append("    Shell->>DB: Read latest results")
    lines.append("    Shell-->>User: Return batch summary")
    lines.append("```")

    return "\n".join(lines)


def generate_ml_grading_diagram() -> str:
    """Generate Mermaid.js ML grading flow diagram."""
    lines = []
    lines.append("```mermaid")
    lines.append("graph LR")
    lines.append("    subgraph Round1[Round 1: ABC Initial Grading]")
    lines.append("        N06B[n06b Node]")
    lines.append("        News[News-based Heating]")
    lines.append("        ABC[S/A/B/C Classification]")
    lines.append("    end")
    lines.append("")
    lines.append("    subgraph Round2[Round 2: ML Model Scoring]")
    lines.append("        N10[n10 Node]")
    lines.append("        XGBoost[XGBoost Model]")
    lines.append("        Features[Feature Engineering]")
    lines.append("        MLScore[ML Scores]")
    lines.append("    end")
    lines.append("")
    lines.append("    N06B --> News")
    lines.append("    News --> ABC")
    lines.append("    N10 --> Features")
    lines.append("    Features --> XGBoost")
    lines.append("    XGBoost --> MLScore")
    lines.append("")
    lines.append("    ABC --> DB[(ml_grading_results<br/>group_id='ABC_INITIAL')]")
    lines.append("    MLScore --> DB2[(ml_grading_results<br/>group_id='ML_XGBOOST')]")
    lines.append("```")

    return "\n".join(lines)


def generate_architecture_docs(structure: dict) -> str:
    """Generate complete architecture documentation."""
    lines = []
    lines.append("# Architecture Overview")
    lines.append("")
    lines.append(f"**Generated (Beijing/UTC+8):** {datetime.now(timezone(timedelta(hours=8))).isoformat()}")
    lines.append("")
    lines.append("This document is auto-generated from the codebase structure.")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## System Architecture")
    lines.append("")
    lines.append("The gupiao system follows a microservices architecture with the following components:")
    lines.append("")
    lines.append(generate_mermaid_architecture_diagram(structure))
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Data Flow")
    lines.append("")
    lines.append("### Night Flow (夜间分析流程)")
    lines.append("")
    lines.append("The Night flow performs comprehensive evening analysis:")
    lines.append("")
    lines.append("1. **n01**: Environment initialization")
    lines.append("2. **n02**: Macro risk assessment")
    lines.append("3. **n03**: News fetching")
    lines.append("4. **n04**: Entity relationship extraction")
    lines.append("5. **n05**: Hotspot detection + keyword expansion")
    lines.append("6. **n06**: Candidate stock matching + ABC grading")
    lines.append("7. **n07**: Market data acquisition")
    lines.append("8. **n10**: ML model scoring (XGBoost)")
    lines.append("9. **n11**: Decision generation")
    lines.append("10. **n13**: Micro risk control")
    lines.append("11. **n15**: Persistence")
    lines.append("")
    lines.append(generate_data_flow_diagram())
    lines.append("")
    lines.append("### Morning Flow (早盘流程)")
    lines.append("")
    lines.append("The Morning flow performs pre-market analysis:")
    lines.append("")
    lines.append("1. **m01**: Environment check")
    lines.append("2. **m02**: Macro risk update")
    lines.append("3. **m03**: Auction data")
    lines.append("4. **m04**: Script matching")
    lines.append("5. **m05**: Micro risk assessment")
    lines.append("6. **m06**: Push notifications")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## ML Grading System")
    lines.append("")
    lines.append("The system uses a two-round ML grading architecture:")
    lines.append("")
    lines.append(generate_ml_grading_diagram())
    lines.append("")
    lines.append("### Round 1: ABC Initial Grading")
    lines.append("")
    lines.append("- **Node**: n06b")
    lines.append("- **Method**: News-based heating analysis")
    lines.append("- **Output**: S/A/B/C preliminary classification (Top 100/200/300)")
    lines.append("- **Storage**: `ml_grading_results` table with `group_id='ABC_INITIAL'`")
    lines.append("")
    lines.append("### Round 2: ML Model Scoring")
    lines.append("")
    lines.append("- **Node**: n10")
    lines.append("- **Method**: XGBoost model scoring")
    lines.append("- **Features**: Technical indicators, volatility, momentum")
    lines.append("- **Output**: Refined S/A/B/C grades")
    lines.append("- **Storage**: `ml_grading_results` table with `group_id='ML_XGBOOST'`")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Component Structure")
    lines.append("")
    lines.append("### Backend (`backend/`)")
    lines.append("")
    lines.append(f"- **Layers**: {', '.join(structure['backend']['layers']) or 'N/A'}")
    lines.append(f"- **Top-level modules**: {', '.join(structure['backend']['modules']) or 'N/A'}")
    lines.append("")
    lines.append("### Frontend (`web/`)")
    lines.append("")
    lines.append(f"- **Components**: {len(structure['web']['components'])} Vue components")
    lines.append(f"- **Pages**: {len(structure['web']['pages'])} route pages")
    lines.append(f"- **Services**: {len(structure['web']['services'])} API service modules")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Technology Stack")
    lines.append("")
    lines.append("| Layer | Technology | Purpose |")
    lines.append("|-------|------------|---------|")
    lines.append("| Frontend | Vue 3 + TypeScript | Reactive UI |")
    lines.append("| Backend | TypeScript (Node.js) + HTTP shell | Local/CI-friendly API surface |")
    lines.append("| Database | PostgreSQL + AGExtension | Data persistence |")
    lines.append("| Cache | Redis | Session & result caching |")
    lines.append("| ML | XGBoost + scikit-learn | Stock scoring |")
    lines.append("| LLM | MiniMax/OpenAI API | Text analysis |")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("*This architecture documentation was auto-generated by `scripts/generate_architecture_diagram.py`*")

    return "\n".join(lines)


def main() -> int:
    """Main entry point."""
    output_path = "docs/architecture/overview.md"

    # Parse arguments
    if len(sys.argv) > 1:
        if sys.argv[1] == "--output" and len(sys.argv) > 2:
            output_path = sys.argv[2]
        elif sys.argv[1].startswith("--output="):
            output_path = sys.argv[1].split("=", 1)[1]

    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    print(f"🏗️  Generating architecture documentation...")

    # Analyze project structure
    root_dir = Path(__file__).parent.parent
    structure = analyze_project_structure(str(root_dir))

    print(f"✅ Analyzed project structure")
    print(f"   - Backend layers: {len(structure['backend']['layers'])}")
    print(f"   - Backend top-level modules: {len(structure['backend']['modules'])}")
    print(f"   - Web components: {len(structure['web']['components'])}")
    print(f"   - Web pages: {len(structure['web']['pages'])}")

    # Generate documentation
    markdown_docs = generate_architecture_docs(structure)

    # Write output
    output_file.write_text(markdown_docs, encoding="utf-8")
    print(f"✅ Architecture documentation written to {output_file}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
