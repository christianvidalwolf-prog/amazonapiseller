"""
Entrypoint para ejecutar el módulo cdiscount como script
"""
import sys
import os

# Asegurar que el directorio cdiscount está en el path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Importar el módulo principal
from cdiscount.main import main

if __name__ == "__main__":
    sys.exit(main())
