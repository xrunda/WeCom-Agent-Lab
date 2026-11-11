import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NotConnectedPage } from '../src/components/NotConnectedPage.tsx';

describe('真实模式未接入页', () => {
  it('明确标注未接入，不展示示例数据', () => {
    render(<NotConnectedPage title="知识库" description="分类维护知识条目。" />);

    expect(screen.getByRole('heading', { name: '知识库' })).toBeInTheDocument();
    expect(screen.getByText('未接入')).toBeInTheDocument();
    expect(screen.getByText('本页尚未接入真实接口')).toBeInTheDocument();
    expect(screen.getByText('真实模式下不展示示例数据')).toBeInTheDocument();
  });
});
