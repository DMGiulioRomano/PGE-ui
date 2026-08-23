import engine_corpus


def pytest_report_header(config):
    """Dice in testa alla run quanto verificheranno i test sul corpus (#132)."""
    return engine_corpus.status_line()
