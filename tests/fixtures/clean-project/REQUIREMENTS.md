# REQUIREMENTS.md

## Project
- **Name:** unitconv
- **One-line purpose:** Offline command-line unit converter for temperature and length.
- **Type:** script/automation
- **Deployment target:** local CLI (Python 3.10+, standard library only)

## Functional requirements
- R1: Convert temperatures between Celsius, Fahrenheit, and Kelvin.
- R2: Convert lengths between metres, kilometres, miles, and feet.
- R3: Invalid input (unknown unit, non-numeric value, temperature below absolute zero) prints a clear error and exits with code 2.
- R4: Every conversion has a unit test.
- R5: No network access and no data collection.
