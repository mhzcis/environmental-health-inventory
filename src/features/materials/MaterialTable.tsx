import { Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Button } from '@mui/material';
import { Material } from '../../types';

interface Props {
  materials: Material[];
}

export default function MaterialTable({ materials }: Props) {
  return (
    <TableContainer component={Paper}>
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>الكود</TableCell>
            <TableCell>الاسم</TableCell>
            <TableCell>التصنيف</TableCell>
            <TableCell>الرصيد الحالي</TableCell>
            <TableCell>الإجراءات</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {materials.map((m, idx) => (
            <TableRow key={`${m.id}-${idx}`}>
              <TableCell>{m.code}</TableCell>
              <TableCell>{m.name}</TableCell>
              <TableCell>{m.category}</TableCell>
              <TableCell>{m.currentStock}</TableCell>
              <TableCell>
                <Button>تعديل</Button>
                <Button color="error">حذف</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
