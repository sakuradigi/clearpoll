import json
import os
import csv
from openpyxl import Workbook

# Directory paths
polls_dir = 'data/polls'
output_dir = 'sheets_import'
os.makedirs(output_dir, exist_ok=True)

# List of poll files (2026 and 2022)
files = [f for f in os.listdir(polls_dir) if f.endswith('.json')]

headers = ['id', 'date', 'pollster', 'pollsterName', 'sampleSize', 'method', 'marginOfError', 'results', 'neutralResults', 'undecided', 'source']

def dict_to_str(d):
    if not d:
        return ''
    return ','.join(f"{k}:{v}" for k, v in d.items())

# Create Workbook for single Excel import
wb = Workbook()
# Remove default sheet
default_sheet = wb.active
wb.remove(default_sheet)

for filename in files:
    filepath = os.path.join(polls_dir, filename)
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    election_id = data.get('electionId')
    polls = data.get('polls', [])
    if not polls:
        continue
    
    # 1. Export as separate CSV
    output_filename = f"{election_id}.csv"
    output_filepath = os.path.join(output_dir, output_filename)
    
    with open(output_filepath, 'w', encoding='utf-8', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        
        for poll in polls:
            results_str = dict_to_str(poll.get('results'))
            neutral_str = dict_to_str(poll.get('neutralResults'))
            
            writer.writerow([
                poll.get('id', ''),
                poll.get('date', ''),
                poll.get('pollster', ''),
                poll.get('pollsterName', ''),
                poll.get('sampleSize', ''),
                poll.get('method', ''),
                poll.get('marginOfError', ''),
                results_str,
                neutral_str,
                poll.get('undecided', ''),
                poll.get('source', '')
            ])
    
    print(f"Exported CSV: {output_filepath}")

    # 2. Add as Excel Sheet
    # Sheet titles can have max 31 characters
    sheet_title = election_id[:31]
    ws = wb.create_sheet(title=sheet_title)
    ws.append(headers)
    
    for poll in polls:
        results_str = dict_to_str(poll.get('results'))
        neutral_str = dict_to_str(poll.get('neutralResults'))
        ws.append([
            poll.get('id', ''),
            poll.get('date', ''),
            poll.get('pollster', ''),
            poll.get('pollsterName', ''),
            poll.get('sampleSize', ''),
            poll.get('method', ''),
            poll.get('marginOfError', ''),
            results_str,
            neutral_str,
            poll.get('undecided', ''),
            poll.get('source', '')
        ])

# Save consolidated Excel file
excel_path = os.path.join(output_dir, 'clearpoll_database.xlsx')
wb.save(excel_path)
print(f"Exported Excel workbook: {excel_path}")
