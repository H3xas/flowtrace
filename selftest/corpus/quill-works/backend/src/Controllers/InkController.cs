using AutoMapper;
using Quill.Works.Mapping;
using Microsoft.AspNetCore.Mvc;

namespace Quill.Works.Controllers
{
    [ApiController]
    [Route("inks/v1")]
    public class InkController : ControllerBase
    {
        private readonly IMapper _mapper;

        public InkController(IMapper mapper)
        {
            _mapper = mapper;
        }

        [HttpPost("receipt")]
        public IActionResult Receipt([FromBody] InkOrder order)
        {
            var receipt = _mapper.Map<InkReceipt>(order);
            return Ok(receipt);
        }

        [HttpPost("label")]
        public IActionResult Label([FromBody] InkBatch batch)
        {
            var label = _mapper.Map<InkBatch, InkLabel>(batch);
            return Ok(label);
        }

        [HttpPost("note")]
        public IActionResult Note([FromBody] InkOrder order)
        {
            var note = _mapper.Map<InkNote>(order);
            return Ok(note);
        }
    }
}
