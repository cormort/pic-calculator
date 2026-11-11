"""驗算邏輯已搬到前端 (static/index.html)；後端僅回傳空殼以維持 API 相容。"""

from typing import Any, Dict, List


def verify_table(table_data: List[List[str]]) -> Dict[str, Any]:
    return {
        "errors": [],
        "cell_status": [],
        "ok_count": 0,
        "error_count": 0,
        "summary": "請於前端選擇驗算模式並指定欄/列",
    }
