#!/usr/bin/env python3
"""
測試運行腳本
執行各種類型的測試並生成報告
"""

import os
import sys
import subprocess
import argparse
from pathlib import Path


def run_command(cmd: list, cwd: str = None) -> int:
    """執行命令並返回退出碼"""
    print(f"執行命令: {' '.join(cmd)}")
    if cwd:
        print(f"工作目錄: {cwd}")
    
    result = subprocess.run(cmd, cwd=cwd)
    return result.returncode


def run_backend_tests(test_type: str = "all") -> int:
    """運行後端測試"""
    print("\n🧪 運行後端測試...")
    
    base_cmd = ["python", "-m", "pytest"]
    
    if test_type == "unit":
        cmd = base_cmd + ["-m", "unit", "--cov=app", "--cov-report=html"]
    elif test_type == "integration":
        cmd = base_cmd + ["-m", "integration"]
    elif test_type == "contract":
        cmd = base_cmd + ["-m", "contract", "tests/test_api_contract.py"]
    else:
        cmd = base_cmd + ["--cov=app", "--cov-report=html", "--cov-report=term"]
    
    return run_command(cmd, cwd="python_backend")


def run_frontend_tests(test_type: str = "all") -> int:
    """運行前端測試"""
    print("\n🎨 運行前端測試...")
    
    if test_type == "contract":
        cmd = ["npm", "test", "--", "api-contract.test.ts", "--watchAll=false"]
    else:
        cmd = ["npm", "test", "--", "--watchAll=false", "--coverage"]
    
    return run_command(cmd, cwd="client")


def run_type_checks() -> int:
    """運行型別檢查"""
    print("\n🔍 運行型別檢查...")
    
    # 後端型別檢查
    print("檢查後端型別...")
    backend_result = run_command(["python", "-m", "mypy", "app"], cwd="python_backend")
    
    # 前端型別檢查
    print("檢查前端型別...")
    frontend_result = run_command(["npm", "run", "type-check"], cwd="client")
    
    return max(backend_result, frontend_result)


def run_linting() -> int:
    """運行程式碼檢查"""
    print("\n🧹 運行程式碼檢查...")
    
    # 後端 linting
    print("檢查後端程式碼...")
    backend_result = run_command(["python", "-m", "flake8", "app"], cwd="python_backend")
    
    # 前端 linting
    print("檢查前端程式碼...")
    frontend_result = run_command(["npm", "run", "lint"], cwd="client")
    
    return max(backend_result, frontend_result)


def generate_test_report():
    """生成測試報告"""
    print("\n📊 生成測試報告...")
    
    report_dir = Path("test_reports")
    report_dir.mkdir(exist_ok=True)
    
    # 後端覆蓋率報告
    backend_coverage = Path("python_backend/htmlcov")
    if backend_coverage.exists():
        print(f"後端覆蓋率報告: {backend_coverage.absolute()}/index.html")
    
    # 前端覆蓋率報告
    frontend_coverage = Path("client/coverage")
    if frontend_coverage.exists():
        print(f"前端覆蓋率報告: {frontend_coverage.absolute()}/lcov-report/index.html")


def main():
    parser = argparse.ArgumentParser(description="運行測試套件")
    parser.add_argument(
        "--type",
        choices=["all", "unit", "integration", "contract", "lint", "type-check"],
        default="all",
        help="測試類型"
    )
    parser.add_argument(
        "--backend-only",
        action="store_true",
        help="只運行後端測試"
    )
    parser.add_argument(
        "--frontend-only", 
        action="store_true",
        help="只運行前端測試"
    )
    parser.add_argument(
        "--no-coverage",
        action="store_true",
        help="跳過覆蓋率報告"
    )
    
    args = parser.parse_args()
    
    exit_codes = []
    
    if args.type == "lint":
        exit_codes.append(run_linting())
    elif args.type == "type-check":
        exit_codes.append(run_type_checks())
    else:
        # 運行測試
        if not args.frontend_only:
            exit_codes.append(run_backend_tests(args.type))
        
        if not args.backend_only:
            exit_codes.append(run_frontend_tests(args.type))
        
        # 型別檢查
        if args.type == "all":
            exit_codes.append(run_type_checks())
            exit_codes.append(run_linting())
        
        # 生成報告
        if not args.no_coverage:
            generate_test_report()
    
    # 總結
    max_exit_code = max(exit_codes) if exit_codes else 0
    
    if max_exit_code == 0:
        print("\n✅ 所有測試通過！")
    else:
        print(f"\n❌ 測試失敗，退出碼: {max_exit_code}")
    
    return max_exit_code


if __name__ == "__main__":
    sys.exit(main())
