"""
Validación de datos de productos para Cdiscount
"""

import os
import sys
import re
from typing import Any, Dict, List, Optional, Set, Tuple
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import product_config
from logger import logger


@dataclass
class ValidationResult:
    """Resultado de validación"""
    is_valid: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    missing_required: List[str] = field(default_factory=list)
    
    def add_error(self, error: str) -> None:
        self.is_valid = False
        self.errors.append(error)
    
    def add_warning(self, warning: str) -> None:
        self.warnings.append(warning)
    
    def add_missing(self, field_name: str) -> None:
        self.is_valid = False
        self.missing_required.append(field_name)
    
    def __str__(self) -> str:
        lines = []
        if self.is_valid:
            lines.append("✅ Validación exitosa")
        else:
            lines.append("❌ Validación fallida:")
            if self.missing_required:
                lines.append(f"   Campos obligatorios faltantes: {', '.join(self.missing_required)}")
            if self.errors:
                lines.append(f"   Errores: {', '.join(self.errors)}")
        if self.warnings:
            lines.append(f"   ⚠️ Advertencias: {', '.join(self.warnings)}")
        return "\n".join(lines)


class ProductValidator:
    """
    Validador de productos para Cdiscount
    
    Reglas de validación:
    1. Campos obligatorios por categoría
    2. Formato de datos correcto
    3. Rangos válidos (precios, stock, etc.)
    4. EAN/GTIN válido
    5. Nombres y descripciones válidas
    """
    
    def __init__(self, category_id: Optional[str] = None):
        self.category_id = category_id or "default"
        self.required_fields = self._get_required_fields()
    
    def _get_required_fields(self) -> Set[str]:
        """Obtener campos obligatorios para la categoría"""
        if self.category_id in product_config.REQUIRED_ATTRIBUTES:
            return set(product_config.REQUIRED_ATTRIBUTES[self.category_id])
        return set(["Ean", "Name", "Brand", "Description", "Price", "Stock"])
    
    def validate(self, product_data: Dict[str, Any]) -> ValidationResult:
        """Validar datos de producto"""
        result = ValidationResult(is_valid=True)
        
        # Validar campos obligatorios
        self._validate_required_fields(product_data, result)
        
        # Validar formato de datos
        self._validate_data_formats(product_data, result)
        
        # Validar rangos
        self._validate_ranges(product_data, result)
        
        # Validar EAN
        self._validate_ean(product_data, result)
        
        # Validar nombres y descripciones
        self._validate_text_fields(product_data, result)
        
        return result
    
    def _validate_required_fields(self, data: Dict[str, Any], result: ValidationResult) -> None:
        """Validar campos obligatorios"""
        for field in self.required_fields:
            if field not in data or not data.get(field):
                # Algunas alternativas para EAN
                if field.lower() == "ean":
                    alternatives = ["EAN", "Ean", "GTIN", "Gtin", "gtin", "ean", "upc"]
                    found = False
                    for alt in alternatives:
                        if alt in data and data[alt]:
                            data[field] = data[alt]
                            found = True
                            break
                    if not found:
                        result.add_missing(field)
                else:
                    result.add_missing(field)
    
    def _validate_data_formats(self, data: Dict[str, Any], result: ValidationResult) -> None:
        """Validar formatos de datos"""
        # Validar que los campos sean del tipo correcto
        if "Price" in data:
            try:
                price = float(data["Price"])
                if price < 0:
                    result.add_error("Precio no puede ser negativo")
            except (ValueError, TypeError):
                result.add_error("Precio debe ser numérico")
        
        if "Stock" in data:
            try:
                stock = int(data["Stock"])
                if stock < 0:
                    result.add_error("Stock no puede ser negativo")
            except (ValueError, TypeError):
                result.add_error("Stock debe ser entero")
        
        if "Ean" in data:
            ean = str(data["Ean"]).strip()
            if ean and not self._is_valid_ean(ean):
                result.add_error(f"EAN inválido: {ean}")
    
    def _validate_ranges(self, data: Dict[str, Any], result: ValidationResult) -> None:
        """Validar rangos de valores"""
        if "Price" in data:
            try:
                price = float(data["Price"])
                if price < product_config.MIN_PRICE:
                    result.add_error(f"Precio mínimo: {product_config.MIN_PRICE}€")
                if price > product_config.MAX_PRICE:
                    result.add_warning(f"Precio muy alto: {price}€ (máx recomendado: {product_config.MAX_PRICE}€)")
            except (ValueError, TypeError):
                pass  # Ya validado en formato
        
        if "Stock" in data:
            try:
                stock = int(data["Stock"])
                if stock < product_config.MIN_STOCK:
                    result.add_error(f"Stock mínimo: {product_config.MIN_STOCK}")
                if stock > product_config.MAX_STOCK:
                    result.add_warning(f"Stock máximo excedido: {stock} (máx: {product_config.MAX_STOCK})")
            except (ValueError, TypeError):
                pass
    
    def _validate_ean(self, data: Dict[str, Any], result: ValidationResult) -> None:
        """Validar EAN/GTIN"""
        ean_field = "Ean"
        if ean_field in data and data[ean_field]:
            ean = str(data[ean_field]).strip()
            
            if not ean:
                result.add_error("EAN vacío")
                return
            
            # Verificar formato
            ean_clean = re.sub(r'[^0-9]', '', ean)
            
            # EAN-8: 8 dígitos
            # EAN-13: 13 dígitos
            # EAN-14: 14 dígitos
            if len(ean_clean) not in [8, 13, 14]:
                result.add_error(f"EAN debe tener 8, 13 o 14 dígitos: {ean}")
                return
            
            # Validar checksum (opcional, pero recomendado)
            if not self._validate_ean_checksum(ean_clean):
                result.add_warning(f"EAN con checksum inválido: {ean}")
    
    def _validate_text_fields(self, data: Dict[str, Any], result: ValidationResult) -> None:
        """Validar campos de texto"""
        text_fields = ["Name", "Description", "Brand"]
        
        for field in text_fields:
            if field in data and data[field]:
                value = str(data[field]).strip()
                
                if len(value) < 1:
                    result.add_error(f"{field} vacío")
                elif len(value) > 5000:  # Límite razonable
                    result.add_warning(f"{field} muy largo ({len(value)} caracteres)")
                
                # Verificar caracteres especiales
                if self._has_invalid_characters(value):
                    result.add_warning(f"{field} contiene caracteres especiales no recomendados")
    
    def _is_valid_ean(self, ean: str) -> bool:
        """Verificar si EAN tiene formato válido"""
        ean_clean = re.sub(r'[^0-9]', '', ean)
        return len(ean_clean) in [8, 13, 14]
    
    def _validate_ean_checksum(self, ean: str) -> bool:
        """Validar checksum de EAN-13"""
        if len(ean) != 13:
            return True  # Solo validamos EAN-13
        
        try:
            digits = [int(c) for c in ean]
            checksum = digits[-1]
            
            # Calcular checksum
            sum_val = 0
            for i in range(12):
                digit = digits[i]
                sum_val += digit * (3 if i % 2 == 0 else 1)
            
            calculated_checksum = (10 - (sum_val % 10)) % 10
            return calculated_checksum == checksum
        except (ValueError, IndexError):
            return False
    
    def _has_invalid_characters(self, text: str) -> bool:
        """Verificar caracteres especiales problemáticos"""
        # Caracteres que pueden causar problemas en XML/JSON
        invalid_chars = ['<', '>', '&', '"', "'", '\\', '\n', '\r', '\t']
        return any(char in text for char in invalid_chars)
    
    def fix_product_data(self, product_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Intentar corregir problemas comunes en los datos
        """
        fixed = dict(product_data)
        
        # Limpiar strings
        text_fields = ["Name", "Description", "Brand", "Ean"]
        for field in text_fields:
            if field in fixed and fixed[field]:
                fixed[field] = str(fixed[field]).strip()
        
        # Corregir EAN
        if "Ean" in fixed and fixed["Ean"]:
            ean = str(fixed["Ean"]).strip()
            ean_clean = re.sub(r'[^0-9]', '', ean)
            if len(ean_clean) in [8, 13, 14]:
                fixed["Ean"] = ean_clean
        
        # Asegurar stock mínimo
        if "Stock" in fixed:
            try:
                stock = int(fixed["Stock"])
                fixed["Stock"] = max(stock, product_config.MIN_STOCK)
            except (ValueError, TypeError):
                fixed["Stock"] = product_config.DEFAULT_STOCK
        else:
            fixed["Stock"] = product_config.DEFAULT_STOCK
        
        # Asegurar precio mínimo
        if "Price" in fixed:
            try:
                price = float(fixed["Price"])
                fixed["Price"] = max(price, product_config.MIN_PRICE)
            except (ValueError, TypeError):
                pass
        
        return fixed


# Instancia por defecto
validator = ProductValidator()


def validate_product(product_data: Dict[str, Any], category_id: Optional[str] = None) -> ValidationResult:
    """Validar datos de producto"""
    if category_id:
        validator_instance = ProductValidator(category_id)
    else:
        validator_instance = validator
    
    return validator_instance.validate(product_data)


def fix_product(product_data: Dict[str, Any]) -> Dict[str, Any]:
    """Corregir datos de producto"""
    return validator.fix_product_data(product_data)
