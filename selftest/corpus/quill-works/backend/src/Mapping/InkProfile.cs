using AutoMapper;

namespace Quill.Works.Mapping
{
    public class InkOrder { public string Code { get; set; } }
    public class InkReceipt { public string Code { get; set; } }
    public class InkBatch { public string Code { get; set; } }
    public class InkLabel { public string Code { get; set; } public string Tint { get; set; } }
    public class InkNote { public string Code { get; set; } }

    public class InkProfile : Profile
    {
        public InkProfile()
        {
            CreateMap<InkOrder, InkReceipt>()
                .ConvertUsing<InkReceiptConverter>();
            CreateMap<InkBatch, InkLabel>()
                .ForMember(d => d.Code, o => o.ConvertUsing<BatchCodeConverter, string>(s => s.Code))
                .ForMember(d => d.Tint, o => o.MapFrom<TintResolver>())
                .AfterMap<LabelStamp>();
        }
    }

    public class LooseMaps
    {
        public void Setup()
        {
            CreateMap<InkOrder, InkNote>().ConvertUsing<NoteConverter>();
        }
    }

    public class InkReceiptConverter : ITypeConverter<InkOrder, InkReceipt>
    {
        public InkReceipt Convert(InkOrder source, InkReceipt destination, ResolutionContext context)
        {
            return new InkReceipt { Code = source.Code };
        }
    }

    public class BatchCodeConverter : IValueConverter<string, string>
    {
        public string Convert(string source, ResolutionContext context)
        {
            return source.Trim();
        }
    }

    public class TintResolver : IValueResolver<InkBatch, InkLabel, string>
    {
        public string Resolve(InkBatch source, InkLabel destination, string member, ResolutionContext context)
        {
            return source.Code.Substring(0, 1);
        }
    }

    public class LabelStamp : IMappingAction<InkBatch, InkLabel>
    {
        public void Process(InkBatch source, InkLabel destination, ResolutionContext context)
        {
            destination.Code = source.Code;
        }
    }

    public class NoteConverter : ITypeConverter<InkOrder, InkNote>
    {
        public InkNote Convert(InkOrder source, InkNote destination, ResolutionContext context)
        {
            return new InkNote();
        }
    }
}
